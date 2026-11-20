// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Charges filled in from the last visit. Opening the Charges step of an encounter that is still in
// progress and has no charge account puts the patient's most recent earlier services on the live
// table at this encounter's practice prices, with this encounter's diagnoses — no button pressed, no
// amount copied from the old visit, and nothing that ever has to be typed again.
//
// No npm packages: the rows are markup strings, parsed into the same small hand-written element
// stubs the other charge UI scripts use, with web/billing.js, web/fees.js and web/visit-billing.js
// loaded into a node vm and driven through the handlers they install on the document. Every value
// below is synthetic.

const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

// ---- the hand-written DOM --------------------------------------------------------------
const PROP_ALIAS={colspan:'colSpan'};
const VOID_TAGS=new Set(['input','br','img','meta','link','hr','source']);
// Where the parser stands in the markup, used to settle a <select>'s value once its options are
// all in, exactly as a browser reports it.

function parseMarkup(html){
 const stack=[];const roots=[];const re=/<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;let last=0,match;
 const top=()=>stack.length?stack[stack.length-1]:null;
 const push=node=>{
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
   for(let i=stack.length-1;i>=0;i--)if(stack[i].tag===tag){
    const closed=stack[i];
    if(closed.tag==='option'&&closed.attrs.value===undefined)closed._value=closed.textContent;
    const popped=stack.length-1-i;
    for(let step=0;step<popped&&open.length;step++)open.pop();
    if(closed.tag==='select')settleSelect(closed);
    stack.length=i;break;}
   continue;
  }
  const node=makeNode(tag);
  const bare=attrText.trim()==='/';
  for(const part of bare?[]:attrText.match(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)||[]){
   const m=/^([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?$/.exec(part.trim());if(!m)continue;
   const name=m[1].toLowerCase(),value=m[2]!==undefined?m[2]:m[3]!==undefined?m[3]:true;
   if(value===true){node.attrs[name]=true;if(name==='open')node.open=true;if(name==='hidden')node.hidden=true;if(name==='selected')node.attrs.selected=true;}
   else{node.attrs[name]=String(value);node.dataset[camel(name)]=String(value);
    if(name==='value'){node._value=String(value);}
    if(PROP_ALIAS[name])node[PROP_ALIAS[name]]=String(value);}
  }
  push(node);

  if(['p','option','li'].includes(tag))node.autoClose=true;
  if(!selfClose&&!VOID_TAGS.has(tag))stack.push(node);
 }
 if(top())top()._text+=html.slice(last);
 return roots;
}
// The browser's rule: the first option marked selected, otherwise the first option. The markup is
// parsed top down, so the options are all attached by the time the select closes.
function settleSelect(select){
 const options=select.children.filter(child=>child.tag==='option');
 const chosen=options.find(option=>option.attrs.selected===true)||options[0];
 if(!chosen)return;
 select.selectSelected=select.children.indexOf(chosen);
 select._value=String(chosen.attrs.value??chosen.textContent);
}
function camel(name){return name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());}
const dashed=key=>key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
let uid=0;
function makeNode(tag){
 const node={_id:++uid,tag:tag||'fragment',attrs:Object.create(null),children:[],_text:'',parent:null,_value:'',open:false};
 node.dataset=new Proxy(Object.create(null),{
  get:(map,key)=>key in map?map[key]:node.attrs['data-'+dashed(String(key))]??undefined,
  set:(map,key,value)=>{map[key]=String(value);node.attrs['data-'+dashed(String(key))]=String(value);return true;},
  has:(map,key)=>key in map||('data-'+dashed(String(key))) in node.attrs,
  deleteProperty:(map,key)=>{delete map[key];delete node.attrs['data-'+dashed(String(key))];return true;},
  ownKeys:map=>Object.keys(map),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
 Object.defineProperty(node,'value',{get:()=>node._value,set:v=>{node._value=String(v);}});
 Object.defineProperty(node,'textContent',{
  get(){if(tag==='select'&&!node._text){const option=node.children[node.selectSelected??0];return option?option.textContent:'';}
   return node._text+node.children.map(child=>child.textContent).join('');},
  set(text){node._text=String(text);node.children.length=0;}});
 Object.defineProperty(node,'innerHTML',{
  get(){return (node._text||'')+node.children.map(child=>child.outerHTML).join('');},
  set(html){dropRegistered(node);node.children=[];node._text='';attachChildren(node,parseMarkup(String(html)));}});
 Object.defineProperty(node,'outerHTML',{get(){return serialize(node);}});
 Object.defineProperty(node,'lastElementChild',{get(){return node.children.at(-1)??null;}});
 Object.defineProperty(node,'firstElementChild',{get(){return node.children[0]??null;}});
 node.isConnected=true;
 node.setAttribute=(name,value)=>{name=String(name).toLowerCase();node.attrs[name]=String(value);if(name.startsWith('data-'))node.dataset[camel(name)]=String(value);if(name==='value')node._value=String(value);if(PROP_ALIAS[name])node[PROP_ALIAS[name]]=String(value);};
 node.getAttribute=name=>{const value=node.attrs[String(name).toLowerCase()];return value===undefined?null:value===true?'':value;};
 node.hasAttribute=name=>String(name).toLowerCase() in node.attrs;
 node.removeAttribute=name=>{delete node.attrs[String(name).toLowerCase()];};
 node.closest=selector=>{let at=node;while(at){const parts=String(selector).trim().split(/\s+/);
  if(parts.every((part,index)=>index===parts.length-1?matches(at,part):queryAll(at,parts.slice(index).join(' ')).length>0))return at;at=at.parent;}return null;};
 node.contains=other=>{let at=other;while(at){if(at===node)return true;at=at.parent;}return false;};
 node.querySelector=selector=>queryAll(node,selector)[0]||null;
 node.querySelectorAll=selector=>queryAll(node,selector);
 node.append=(...parts)=>{for(const part of parts)if(typeof part==='string')node._text+=part;else{part.parent?.children.splice(part.parent.children.indexOf(part),1);insertChild(node,part);}};
 node.replaceChildren=(...parts)=>{dropRegistered(node);node._text='';node.append(...parts);};
 node.remove=()=>{if(!node.parent)return;const siblings=node.parent.children,index=siblings.indexOf(node);if(index>=0)siblings.splice(index,1);node.parent=null;release(node);dropRegistered(node);};
 node.before=other=>{const parent=node.parent;if(!parent)return;other.parent?.children.splice(other.parent.children.indexOf(other),1);const index=parent.children.indexOf(node);other.parent=parent;parent.children.splice(index,0,other);register(other);};
 node.replaceWith=other=>{const parent=node.parent;if(!parent)return;other.parent?.children.splice(other.parent.children.indexOf(other),1);const index=parent.children.indexOf(node);other.parent=parent;parent.children[index]=other;node.parent=null;release(node);register(other);};
 node.focus=()=>{documentStub.activeElement=node;};
 if(['input','textarea'].includes(tag)&&!['checkbox','radio','number'].includes(node.attrs.type)){node.selectionStart=node._value.length;node.setSelectionRange=(a,b)=>{node.selectionStart=a;node.selectionEnd=b;};}
 node.scrollIntoView=()=>{};
 node.insertAdjacentHTML=(where,html)=>{
  const parts=parseMarkup(String(html));
  if(where==='afterbegin'){parts.reverse().forEach(part=>{part.parent=node;node.children.unshift(part);register(part);});return;}
  if(where==='beforebegin'){const parent=node.parent;if(!parent)return;const index=parent.children.indexOf(node);parts.forEach((part,offset)=>{part.parent=parent;parent.children.splice(index+offset,0,part);register(part);});return;}
  parts.forEach(part=>insertChild(node,part));};
 if(tag==='tr'){node.cells=node.children.filter(child=>child.tag==='td');node.cells.item=index=>node.cells[index]||null;}
 if(tag==='form'){
  node.elements=new Proxy(Object.create(null),{get:(_,name)=>{if(typeof name!=='string')return undefined;return node.querySelectorAll(`[name="${name}"]`)[0];},has:(target,name)=>queryAll(node,`[name="${name}"]`).length>0,ownKeys:()=>{const names=new Set();for(const field of queryAll(node,'[name]'))names.add(field.attrs.name);return [...names];},getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
 }
 return node;
}
function attachChildren(parent,nodes){for(const child of nodes)insertChild(parent,child);}
// A panel rewritten from scratch leaves everything it held behind, exactly as a live element
// does: the ids it carried stop answering getElementById once they are gone from the document.
function release(node){node.isConnected=false;if(node.attrs.id&&nodes[node.attrs.id]===node)delete nodes[node.attrs.id];}
function detach(node){node.isConnected=false;node.parent=null;for(const child of node.children)detach(child);}
// The children of a rewritten node are gone from the document; the node itself stays, holding its
// id, exactly as a browser leaves it.
function dropRegistered(node){
 for(const child of node.children){detach(child);release(child);dropRegistered(child);}
 node.children=[];
}
function insertChild(parent,child){
 if(parent.tag==='table'&&child.tag==='tr'){
  let body=parent.children.find(cell=>cell.tag==='tbody');
  if(!body){body=makeNode('tbody');body.parent=parent;parent.children.push(body);}
  parent=body;}
 child.parent=parent;parent.children.push(child);register(child);
}
function register(node){
 if(node.attrs.id&&nodes[node.attrs.id]!==node){
  const previous=nodes[node.attrs.id];
  if(previous){previous.isConnected=false;const at=previous.parent?.children.indexOf(previous);if(at>=0)previous.parent.children.splice(at,1);previous.parent=null;}
  nodes[node.attrs.id]=node;node.isConnected=true;
 }
 for(const child of node.children)register(child);
}
function collect(node,selector,out){for(const child of node.children){if(matchesSimple(child,selector))out.push(child);collect(child,selector,out);}}
function queryAll(node,selector){
 const parts=String(selector).trim().split(/\s+(?![^\[]*\])/).filter(Boolean);
 let current=[node];
 for(const part of parts){const found=[];for(const scope of current)collect(scope,part,found);current=found;}
 return current;
}
function matches(node,selector){return String(selector).split(',').some(one=>matchesSimple(node,one.trim()));}
function matchesSimple(node,selector){return String(selector).split(',').some(one=>matchOne(node,one.trim()));}
function matchOne(node,selector){
 const not=/:not\(([^)]+)\)/.exec(selector);
 if(not){if(matchOne(node,not[1]))return false;selector=selector.replace(not[0],'');}
 const classes=selector.match(/\.[\w-]+/g)||[];
 let rest=selector.replace(/\.[\w-]+/g,'');
 const ids=selector.match(/#[\w-]+/g)||[];
 if(ids.length)rest=rest.replace(/#[\w-]+/g,'');
 const attribs=rest.match(/\[[^\]]+\]/g)||[];
 rest=rest.replace(/\[[^\]]+\]/g,'');
 if(!/^(\*|[a-zA-Z][\w-]*)?$/.test(rest))throw new Error('test stub cannot match: '+selector);
 const tag=rest&&rest!=='*'?rest.toLowerCase():null;
 if(tag&&node.tag!==tag)return false;
 if(!ids.every(id=>node.attrs.id===id.slice(1)))return false;
 const className=String(node.attrs.class||'').split(/\s+/);
 if(!classes.every(name=>className.includes(name.slice(1))))return false;
 return attribs.every(expression=>{
  const m=/^\[([:\w-]+)(?:\s*(=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(expression.trim());
  const name=m[1].toLowerCase();
  if(!(name in node.attrs))return false;
  if(m[2]===undefined)return true;
  const want=m[3]!==undefined?m[3]:m[4]!==undefined?m[4]:m[5];
  return String(node.attrs[name])===want;});
}
function serialize(node){
 // A bare attribute is written back bare, never as data-*, so a node's own markup reads the way
 // the page wrote it.
 const attrs=Object.keys(node.attrs).filter(name=>name!=='data-class').map(name=>{
  const value=node.attrs[name];
  return value===true?` ${name}`:` ${name}="${value}"`;}).join('');
 if(node.tag==='input')return `<input${attrs}>`;
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
 addEventListener:(name,fn)=>{(handlers[name]??=[]).push(fn);},
 removeEventListener:(name,fn)=>{const list=handlers[name]||[];const index=list.indexOf(fn);if(index>=0)list.splice(index,1);},
};
function dispatch(type,target){
 const event={type,target,detail:{},bubbles:true,cancelable:true,defaultPrevented:false,preventDefault(){event.defaultPrevented=true;}};
 for(const fn of handlers[type]||[])fn(event);
 return event;
}
const click=node=>dispatch('click',node);
const type=(node,value)=>{node.value=value;dispatch('input',node);};
const change=(node,value)=>{node.value=value;dispatch('change',node);};
const openHost=html=>{const host=makeNode('div');host.innerHTML=html;return host;};
// A panel the page rewrites from scratch, which is how a real element behaves; the earlier
// hand-written stubs only cleared their own markup and left their children findable by id.

// How the page actually reaches the Charges step: the chart is opened on Visits, the encounter
// panel is built with the step chosen, and only then is the step itself opened.
const openStepFor=id=>{ctx.encounterSection='charges';ctx.activeVisit={...visits.find(v=>v.id===id)};};
// The charge rows only answer for the one form that is on screen; two forms can be in the tree
// while a panel is being swapped out, and the one found by id is the live one.
function liveRows(){const form=openForm();return Array.from(form?.querySelectorAll('.billing-charge-row')||[]);}
// Leaving the charges step is what the page's own Cancel does: the live table is put away, so
// each opening of the step starts from the record and nothing left over in the panel.
const closeStep=()=>{vm.runInContext('billingEditorHost()?.replaceChildren();',ctx);};
// A live element keeps its identity while the page rewrites what is inside it; only a node that
// really leaves the document stops answering getElementById.
function buildPanels(){
 nodes['encounter-revenue']=openHost('<div id="encounter-revenue"><div id="encounter-revenue-status"></div><div id="encounter-billing-editor"></div></div>').children[0];
 nodes['billing-editor']=openHost('<div id="billing-editor"></div>').children[0];
 nodes['billing-detail']=openHost('<div id="billing-detail"></div>').children[0];
}
buildPanels();

// ---- the synthetic practice and patient ------------------------------------------------
const visitsAll=()=>[...visits,visitOther];
const visitOther={id:'visit-other-patient',appointment_id:'appt-other',patient_id:'patient-other',status:'signed',created_at:'2026-11-12T14:00:00Z'};
const lineOffice={code_system:'CPT',code:'99213',description:'Office visit',modifiers:'',units:1,amount_cents:15000,diagnosis_codes:['Z00.00'],fee_schedule_id:'schedule-old',fee_entry_key:'CPT:99213:'};
const lineDrug={code_system:'HCPCS',code:'J9270',description:'Injection',modifiers:'LT',units:2,amount_cents:1800,diagnosis_codes:['M62.81'],ndc_code:'00023114501',ndc_quantity:'50',ndc_unit:'UN'};
const account=(id,visitId,day,lines,status='posted',extra={})=>({id,version:4,status,...extra,content:{visit_id:visitId,service_date:day,currency:'USD',notes:'',lines}});
const earlierAccount=account('account-earlier','visit-earlier','2026-10-18',[lineOffice,lineDrug]);
const emptyAccount=account('account-empty','visit-empty','2026-10-04',[]);
const currentDraft=account('account-current','visit-current','2026-11-13',[{...lineOffice}],'draft');
const visits=[
 {id:'visit-current',appointment_id:'appt-current',patient_id:'patient',status:'in_progress',created_at:'2026-11-13T14:00:00Z'},
 {id:'visit-earlier',appointment_id:'appt-earlier',patient_id:'patient',status:'signed',created_at:'2026-10-18T14:00:00Z'},
 {id:'visit-empty',appointment_id:'appt-empty',patient_id:'patient',status:'signed',created_at:'2026-10-04T14:00:00Z'},
];
// The practice's price list, as the fee lookup answers it: 99213 is covered, J9270 is not.
const prices={'99213':16000};
const practicePriceHost={id:'schedule-practice',name:'Practice prices'};

// ---- the vm page -----------------------------------------------------------------------
const sent=[],feeSent=[];
const session=new Map();
const codesIn=url=>{try{return new URLSearchParams(url.split('?')[1]).getAll('code');}catch{return [];}};
// What the page asks for, answered as a practice's own server would, so every panel the encounter
// step draws has its data. The numbers are synthetic and belong to no one.
const blankSummary=()=>({visit_id:'visit-current',status:'in_progress',service_date:'2026-11-13',account:null,claim:null,patient:{owes_now_cents:0},insurance:{paid_cents:0,submitted_cents:0,pending_cents:0}});
const visitSummary=blankSummary();
function apiReply(url,method,body){
 if(url.includes('/fee-context'))return {facilities:[{id:'facility-synthetic',name:'Synthetic Clinic'}],facility_id:'facility-synthetic',setting:'nonfacility',reason:'Practice prices for this facility.'};
 if(url.includes('/fee-quote')){
  const query=new URLSearchParams(url.split('?')[1]),code=query.get('code'),units=Number(query.get('units'));
  feeSent.push(code);
  if(!prices[code])return {quote:null,reason:'No approved price for this code at this encounter.'};
  return {quote:{schedule_id:practicePriceHost.id,entry_key:`CPT:${code}:`,schedule:{name:practicePriceHost.name,qp_basis:'Practice prices',locality:'Practice'},unit_amount_cents:prices[code],units,expected_line_amount_cents:prices[code]*units}};
 }
 if(url.includes('/visit-summary')){
  if(ctx.summaryFails)throw new Error('synthetic outage');
  const visit=visits.find(v=>v.id===visitSummary.visit_id);
  // The state is derived the way a practice's own server would derive it, because the two states
  // that matter here decide the whole visit: an encounter with no charge account is at 'add_charges',
  // and an encounter whose charges are still a draft waits on the encounter note being signed. A summary
  // that offered 'add_charges' beside an existing account would be a reply no server sends, and
  // the card would be shown a button that has nothing to add.
  const account=visitSummary.account;
  const state=!account?'add_charges':account.status!=='draft'?'post_charges':visit&&visit.status==='signed'?'post_charges':'sign_visit';
  return {...structuredClone(visitSummary),state,waiting_on:state==='add_charges'?'staff':state==='sign_visit'?'staff':'nobody',viewer:{role:'owner'},insurance:{...visitSummary.insurance,insured:false}};
 }
 if(url.includes('/diagnoses'))return {version:2,diagnoses:[{id:'dx-1',code:'J10.0',display:'Synthetic joint pain'},{id:'dx-2',code:'M62.81',display:'Synthetic muscle weakness'}]};
 if(method==='POST'||method==='PUT')return {id:'account-new',version:8,status:'draft',content:{visit_id:'visit-current',service_date:'2026-11-13',currency:'USD',notes:'',lines:body.content.lines}};
 return {accounts:[],items:[]};
}
// The vm's timers come back as plain tokens; nothing runs in the background here.
const liveTimers=new Map();let tokenSeq=0;
const vmSetTimeout=(fn,ms,...args)=>{const token=++tokenSeq;liveTimers.set(token,setTimeout(()=>{liveTimers.delete(token);fn(...args);},ms));return token;};
const vmClearTimeout=token=>{const handle=liveTimers.get(token);if(handle){clearTimeout(handle);liveTimers.delete(token);}};
const structuredClone=value=>JSON.parse(JSON.stringify(value));
const ctx={console,setTimeout:vmSetTimeout,clearTimeout:vmClearTimeout,Date,Intl,URL,URLSearchParams,Map,Set,Array,Math,Number,String,JSON,Object,Boolean,RegExp,Error,Promise,Symbol,WeakMap,
 document:documentStub,
 // The browser's session, as a real one: readable and writable, and a page that refuses it is
 // simply answered with an error the code has to survive.
 sessionStorage:{getItem:key=>{if(ctx.sessionBroken)throw new Error('storage disabled');if(!session.has(key))throw new Error('no such key');return session.get(key);},setItem:(key,value)=>{if(ctx.sessionBroken)throw new Error('storage disabled');session.set(key,String(value));},removeItem:key=>{session.delete(key);}},
 localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
 visitsAll,
 crypto:{randomUUID:()=>'synthetic-request'},selected:'patient',me:{role:'owner'},chartSection:'visits',encounterSection:'charges',billingSelected:null,
 workspace:{appointments:[{id:'appt-other',title:'Someone else\u2019s visit',starts_at:'2026-11-12T14:00:00Z'},{id:'appt-current',title:'Office visit',starts_at:'2026-11-13T14:00:00Z'},{id:'appt-earlier',title:'Office visit',starts_at:'2026-10-18T14:00:00Z'},{id:'appt-empty',title:'Office visit',starts_at:'2026-10-04T14:00:00Z'}],visits,billing:{accounts:[],coverages:[],entries:[]}},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 human:v=>String(v??'').replaceAll('_',' '),date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),
 payerName:()=>'Synthetic payer',$:id=>documentStub.getElementById(id),
 visitBillingDate:v=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${v}T00:00:00`)),
 displayDate:v=>String(v),revenueCoverage:()=>null,revenueServiceDate:()=>'2026-11-13',accountDiagnosisSummary:()=>'',billingChargeDraftRecovery:()=>'',accountDiagnosisDraftRecovery:()=>'',
 notice(message){ctx.noticed=message;},run:fn=>fn(),showChartSection(){},setEncounterSection(){},billingCoverageOrderMarkup:()=>'',visitPlanCopayCents:()=>null,
 api:async(url,method='GET',body,version)=>{
   if(url.startsWith('/__trace?')){console.log('REMEMBER\n'+decodeURIComponent(new URL(url,'http://x').searchParams.get('x')));return {};}
  if(url.includes('/fee-quote'))feeSent.push(...codesIn(url));
  sent.push({url,method,body,version});
  if(url.includes('/fee-context'))await settle();
  return apiReply(url,method,body);
 }};
const context=vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/billing.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/fees.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/visit-billing.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),context);
// Card collection is another screen's work; the panel is left out of this encounter's card here.
vm.runInContext('hostedCopayPanel=()=>"";loadHostedCopays=async()=>null;encounterRevenueState={patient:null,identity:null,account:null,pending:null,data:null,loadedAt:0};',ctx);

const $=id=>documentStub.getElementById(id);
const openForm=()=>$('billing-account-form');
const rowsNow=liveRows;
const liveRow=code=>liveRows().find(row=>row.querySelector('[name="code"]')?.value===code);
const codes=()=>rowsNow().map(row=>row.querySelector('[name="code"]').value);
const amountOf=row=>row.querySelector('[name="amount"]').value;
const why=()=>({card:$('encounter-revenue-status')?.innerHTML.replace(/<[^>]*>/g,' ').slice(0,220),propose:vm.runInContext('JSON.stringify(chargeProposeCard())',ctx),ctx:vm.runInContext('JSON.stringify(chargeProposeContext(activeVisit))',ctx),choice:vm.runInContext('chargeProposalChoice(activeVisit.id)',ctx)});
const noteOf=row=>row.querySelector('[data-charge-note-cell]')?.textContent.trim()??'(no cell)';
// A new browser tab, made by hand: every panel the billing page can fill is put back empty, and
// nothing remembered about an encounter carries into the next opening of it.
const freshTab=()=>{
 session.clear();sent.length=0;feeSent.length=0;
 for(const id of Object.keys(nodes))delete nodes[id];
 buildPanels();
 vm.runInContext('billingSelected=null;workspace.visits=visitsAll();',ctx);
};
const settle=async()=>{for(let step=0;step<60;step++)await new Promise(resolve=>setImmediate(resolve));};
// Autosave is drained by hand: cancel the pending timer and run the save it was holding.
const advance=async()=>{
 for(let pass=0;pass<4;pass++){
  const form=openForm();
  if(!form?.chargeSaveTimer)break;
  for(const row of form.querySelectorAll('.billing-charge-row'))delete row.dataset.chargeRemoved;
  vmClearTimeout(form.chargeSaveTimer);form.chargeSaveTimer=null;
  await vm.runInContext('saveChargeTable($("billing-account-form"))',ctx).catch(e=>{console.error('save failed',e);});
  await settle();
 }
};
const openCharges=async()=>{await vm.runInContext('openEncounterCharges()',ctx);await settle();return openForm();};
const setVisit=(id,status='in_progress')=>{ctx.activeVisit={...visits.find(v=>v.id===id),status};};
const summaryFor=(accounts,id,status)=>{
 const account=accounts.find(a=>a.status!=='void'&&a.content.visit_id===id);
 Object.assign(visitSummary,blankSummary(),{visit_id:id,status,account:account?structuredClone(account):null});
 ctx.summaryFails=false;
};
const reset=(accounts,{id='visit-current',status='in_progress'}={})=>{
 // A new visit's panel is built by the page, so the previous visit's account is put away first,
 // exactly as the page's own Cancel puts a live table away.
 closeStep();freshTab();
 vm.runInContext('chargeProposalChoices.clear();encounterRevenueState={patient:null,identity:null,account:null,pending:null,data:null,loadedAt:0};',ctx);
 ctx.sessionBroken=false;ctx.me={role:'owner'};
 // The page's own encounterChargeAccount() reads the chart, and is left exactly as the page
 // defines it: whether this encounter has charges of its own is a fact the test sets by putting
 // accounts in the chart, never by replacing the function that reads them.
 ctx.workspace.billing.accounts=accounts.map(a=>({...a,content:{...a.content,lines:[...a.content.lines]}}));
 summaryFor(ctx.workspace.billing.accounts,id,status);
 setVisit(id,status);
};
// The encounter's Charges step, opened the way the practice opens it. The contract, in one place:
//
//   1. Opening the step draws it with renderEncounterRevenue() and presses nothing. The page builds
//      the charge table itself in exactly one case: the encounter has no charge account and there are
//      charges to fill in from an earlier visit. So the form returned is that filled-in table, or
//      nothing at all — and "nothing" is the honest starting point every other case is measured
//      from, since a table the practice has not been offered yet is not on screen.
//   2. An encounter that already has charges of its own is opened the way staff open it, by the card's
//      own button. That is pressCardCharges() below, which is only ever called for such an encounter and
//      says so out loud if it is asked to open an encounter with nothing to open.
//
// The step is drawn, never both drawn and pressed: pressing the card here would build the very
// table the fill-in is being asked about, and the test would pass for the wrong reason.
const openStep=async(visitId='visit-current',status='in_progress')=>{
 closeStep();openStepFor(visitId);setVisit(visitId,status);
 $('encounter-revenue').dataset.revenueKey='';
 vm.runInContext('renderEncounterRevenue()',ctx);await settle();
 return $('billing-account-form')||null;
};
// 2. The card's own button for an encounter whose charges already exist, pressed through the live
// handler just as a person's click would be.
const pressCardCharges=async()=>{
 const card=$('encounter-revenue-status');
 const button=card?.querySelector('.visit-billing-status .actions button.primary[data-encounter-charges]')||card?.querySelector('[data-encounter-charges]');
 if(!button)throw new Error('the billing card offers no way to open these charges');
 click(button);await settle();
 return $('billing-account-form')||null;
};

(async()=>{
 // ---- 1. the table fills itself in from the most recent earlier visit -------------------
 reset([earlierAccount,emptyAccount]);
 let form=await openStep();
 assert.ok(form,'opening an empty visit\u2019s charges step gives a charge table');
 assert.equal(JSON.stringify(codes()),'["99213","J9270"]','the services from the earlier visit are on the table at once');
 assert.match(form.outerHTML,/Filled in from the encounter on Oct 18, 2026\. Change anything you like\./,'one quiet line says where the lines came from');
 assert.ok(form.querySelector('[data-charge-proposal-blank]'),'and the line offers a way to start blank instead');
 // Amounts come from this encounter's practice prices, never from the old visit's amounts.
 const first=liveRow('99213'),second=liveRow('J9270');
 assert.ok(first&&second,'the two carried lines are on the table in front of the practice');
 assert.equal(amountOf(first),'160.00','the amount is the practice price for this encounter');
 assert.equal(first.querySelector('[data-fee-line]').dataset.feeSchedule,practicePriceHost.id,'the line is linked to the practice price list');
 assert.ok(!first.outerHTML.includes('schedule-old'),'the earlier visit\u2019s price link does not come across');
 assert.ok(!first.outerHTML.includes('150.00'),'the amount the old visit was billed at is not carried over');
 // The service detail travels; the old visit's diagnoses do not.
 assert.equal(second.querySelector('[name="modifiers"]').value,'LT','modifiers carry over as they were done');
 assert.equal(second.querySelector('[name="units"]').value,'2','units carry over as they were done');
 assert.equal(second.querySelector('[name="ndc_code"]').value,'00023114501','the drug\u2019s NDC code carries over');
 assert.equal(second.querySelector('[name="ndc_quantity"]').value,'50','the amount given carries over for checking');
 assert.equal(second.querySelector('[name="ndc_unit"]').value,'UN','the drug unit carries over');
 assert.match(second.outerHTML,/<div class="charge-drug">/,'a drug line is open so its detail is not hidden');
 // No price list entry: the amount stays empty and the row says what it needs, in plain words.
 assert.equal(amountOf(second),'','a code the price list does not cover is left with no amount');
 assert.match(noteOf(second),/Enter the amount/,'and the row says what it still needs');
 // Diagnoses always come from this encounter, never from the earlier one.
 assert.ok(sent.some(call=>call.url.includes('/visits/visit-current/diagnoses')),'this encounter\u2019s diagnoses are read for the lines');
 assert.equal(JSON.stringify(liveRow('99213').querySelectorAll('[data-charge-diagnosis]').map(box=>box.dataset.chargeDiagnosis).sort()),'["J10.0","M62.81"]','this encounter\u2019s diagnoses are offered on the line');
 assert.ok(!form.outerHTML.includes('Z00.00'),'the earlier visit\u2019s diagnoses never come across');
 // The carried-over drug amount is flagged for a look: a note on the row, not a wall between the
 // practice and the table. The row keeps whatever its own line still needs to be complete.
 assert.match(noteOf(second),/Check the amount given/,'a carried-over drug amount is flagged for a check');
 assert.equal(second.querySelector('[data-charge-problem]').textContent,'Add the amount for this line.','the note is not the thing holding the line open');
 type(second.querySelector('[name="diagnoses"]'),'M62.81');
 type(second.querySelector('[name="amount"]'),'9.00');
 assert.equal(second.getAttribute('data-charge-problem')||'','','the amount the practice typed settles the line');
 assert.equal(second.querySelector('[data-charge-problem]').textContent,'','the row has nothing left to answer for');
 // The rows are the live table's own rows, so the autosave that already exists makes the draft.
 assert.equal(form.dataset.autosave,'on','the filled-in table still saves itself');
 type(first.querySelector('[name="diagnoses"]'),'J10.0');
 await advance();
 const posted=sent.find(call=>call.method==='POST');
 assert.ok(posted,'nothing had to be pressed for the lines to be saved');
 assert.equal(posted.url,'/api/v1/patients/patient/billing/accounts');
 // The saved draft is read by code, so a redraw of the table can never make a line about the
 // practice's own edits come out as a line about the fill-in.
 const saved=code=>posted.body.content.lines.find(l=>l.code===code);
 assert.equal(JSON.stringify(posted.body.content.lines.map(l=>l.code).sort()),'["99213","J9270"]');
 assert.equal(saved('99213').amount_cents,16000,'the draft is saved at the practice price');
 assert.equal(JSON.stringify(saved('99213').diagnosis_codes),'["J10.0"]','the diagnoses saved are this encounter\u2019s');
 assert.equal(JSON.stringify(saved('J9270').diagnosis_codes),'["M62.81"]','and on every line, never the earlier visit\u2019s');
 assert.equal(saved('J9270').amount_cents,900,'an amount the practice typed is saved as typed');
 assert.equal(saved('J9270').ndc_quantity,'50','the drug detail saves with the line');
 assert.ok(!JSON.stringify(posted.body).includes('filled-in-earlier-visit'),'the filled-in mark stays in the browser');

 // ---- 2. which visit counts as the earlier one -----------------------------------------
 // An encounter that already has charges of its own is shown as they are, never filled in again. It is
 // opened the way staff open it — by the card's own button — because opening the step alone leaves
 // the table shut, as it does for every visit that is not being filled in.
 reset([earlierAccount,emptyAccount,currentDraft]);
 await openStep();
 assert.ok(!$('billing-account-form'),'a visit with charges of its own is not given a table on being opened');
 form=await pressCardCharges();
 assert.equal(JSON.stringify(codes()),'["99213"]','the encounter\u2019s own draft charges are shown unchanged');
 assert.ok(!form.outerHTML.includes('Filled in from the encounter'),'a visit with charges of its own is offered nothing');
 // An encounter whose only other accounts have no lines has nothing to be filled in from.
 reset([emptyAccount]);
 form=await openStep();
 assert.ok(!form,'with no earlier charges the step still waits for its Add charges button');
 // The most recent earlier visit wins, not the oldest.
 reset([account('account-old','visit-old','2026-08-02',[{code_system:'CPT',code:'20610',description:'Older injection',units:1,amount_cents:9000,diagnosis_codes:[]}]),earlierAccount]);
 form=await openStep();
 assert.equal(JSON.stringify(codes()),'["99213","J9270"]','the most recent earlier visit is the one filled in from');
 // An account already holding this encounter's charges is not a source, nor is a voided one.
 reset([account('account-current-2','visit-current','2026-11-13',[{...lineOffice}]),account('account-void','visit-void','2026-10-18',[{...lineDrug}],'void')]);
 form=await openStep();
 assert.ok(!form,'an account for this encounter and a voided one are nothing to fill in from');
 // A charge record from the previous system is not the practice's own charge history.
 reset([account('account-source','visit-source','2026-10-18',[{...lineOffice}],'posted',{source_history_id:'source-1'})]);
 form=await openStep();
 assert.ok(!form,'a record from the previous system is never filled in from');
 // Only this patient's chart is ever read.
 reset([earlierAccount]);
 ctx.workspace.billing.accounts=[...ctx.workspace.billing.accounts,{id:'account-other',version:2,status:'posted',content:{visit_id:'visit-other-patient',service_date:'2026-11-12',currency:'USD',notes:'',lines:[{code_system:'CPT',code:'99214',description:'Someone else\u2019s visit',units:1,amount_cents:30000,diagnosis_codes:[]}]}}];
 form=await openStep();
 assert.equal(JSON.stringify(codes()),'["99213","J9270"]','another patient\u2019s charges are not on the way in');
 assert.ok(!form.outerHTML.includes('99214'));

 // ---- 3. never offered again once staff have dealt with it ------------------------------
 reset([earlierAccount]);
 form=await openStep();
 click(form.querySelector('[data-charge-proposal-blank]'));
 assert.equal(JSON.stringify(codes()),'[""]','Start blank empties the table down to one blank line');
 assert.ok(!openForm().outerHTML.includes('Filled in from the encounter'),'and takes the quiet line away with it');
 assert.ok(!openForm().querySelector('[data-charge-proposal-blank]'),'and nothing is left to press');
 // The answer staff gave by pressing Start blank is kept: leaving the step and coming back finds
 // the table shut, the encounter not refilled from the earlier visit, and the card back to its usual
 // ask rather than the fill-in's "Check the charges". Reopening an encounter that has no account of its
 // own can only ever produce the fill-in, so this is the honest check that it was refused.
 closeStep();
 await openStep();
 assert.ok(!$('billing-account-form'),'a visit staff emptied is not quietly given a table again');
 assert.ok(!($('encounter-revenue-status')?.innerHTML.includes('Filled in from the encounter')),'nor is the encounter still spoken of as filled in');
 assert.ok(!($('encounter-revenue-status')?.innerHTML.includes('Check the charges')),'and the card asks for charges in its usual words');
 // Emptying the table by hand is the same answer, and is kept the same way.
 reset([earlierAccount]);
 form=await openStep();
 for(const row of [...rowsNow()])click(row.querySelector('[data-remove-charge]'));
 assert.equal(JSON.stringify(codes()),'[]','removing every line empties the table');
 await advance();
 closeStep();
 await openStep();
 assert.ok(!$('billing-account-form'),'a table staff emptied themselves is never quietly refilled');
 assert.ok(!($('encounter-revenue-status')?.innerHTML.includes('Filled in from the encounter')));
 // A browser that will not hand out its session still behaves: the memory lives in the page.
 reset([earlierAccount]);
 ctx.sessionBroken=true;
 form=await openStep();
 assert.equal(JSON.stringify(codes()),'["99213","J9270"]','a refused session store does not stop the table filling in');
 click(form.querySelector('[data-charge-proposal-blank]'));
 closeStep();
 await openStep();
 assert.ok(!$('billing-account-form'),'and the choice is still remembered for this encounter without the session store');

 // ---- 4. who is ever offered this ------------------------------------------------------
 // Read-only staff are not offered charges to change, and are not blocked from the encounter. The page
 // decides this through its own billingWrite(), which reads the signed-in role, so the role is what
 // is changed here; a stub over billingCan() would switch off one caller and leave the table open.
 reset([earlierAccount]);
 ctx.me={role:'scribe'};
 await openStep();
 assert.ok(!$('billing-account-form'),'staff who cannot write are not put in front of a table to change');
 // An encounter that is no longer in progress is never offered it.
 reset([earlierAccount]);
 ctx.workspace.billing.accounts=[];
 form=await openStep('visit-earlier','signed');
 assert.ok(!form,'a visit that is not in progress still waits for its own button');
 // Once the encounter has an account the table is never refilled from an earlier visit: the charges on
 // screen are the encounter's own, opened the way staff open them.
 reset([earlierAccount,currentDraft]);
 await openStep();
 form=await pressCardCharges();
 assert.ok(!form.outerHTML.includes('Filled in from the encounter'),'an account that exists is left alone');
 assert.equal(JSON.stringify(codes()),'["99213"]','and what is shown are its own charges');
 // An encounter that was filled in, saved, and whose account was then taken away again is not silently
 // offered the lines a second time: the practice has already been given its answer for this encounter.
 // The charge table refuses it from its own memory of the encounter, so reopening the step — the only
 // thing that can ever produce a fill-in — is what proves it.
 reset([earlierAccount]);
 form=await openStep();
 type(form.querySelector('[name="diagnoses"]'),'J10.0');
 await advance();
 assert.ok(sent.some(call=>call.method==='POST'),'the filled-in table was saved as this encounter\u2019s charges');
 ctx.workspace.billing.accounts=[earlierAccount];
 summaryFor(ctx.workspace.billing.accounts,'visit-current','in_progress');
 closeStep();
 await openStep();
 assert.ok(!$('billing-account-form'),'the encounter was already filled in once; it is not offered a second time');

 // ---- 5. the encounter billing card stops asking for charges by hand ------------------------
 // The card is drawn straight from an encounter summary at 'add_charges' — an encounter with no charges yet —
 // with the practice's owner looking at it. It reads the chart for anything to fill in from, which
 // is why the accounts in the chart decide its words. Whether a person may press anything is the
 // card's own context: canCreate and canWrite.
 const addCharges=()=>({patient_id:'patient',visit:{id:'visit-current',status:'in_progress',appointment_id:'appt-current'},state:'add_charges',waiting_on:'staff',account:null,charges_cents:null,balance_cents:null,claim:null,claim_count:0,insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:true,status:'not_billed',paid_cents:0,adjusted_cents:0,pending_cents:0,unassigned_cents:0},patient:{owes_now_cents:0,received_cents:0},receipts:[],statement:{current:false,latest_id:null,count:0},timeline:[]});
 const owner={canCreate:true,canWrite:true,claimsAllowed:true};
 const markup=()=>ctx.visitBillingCardMarkup(addCharges(),owner);
 // With an earlier visit that has charges, the card says they are already on the way.
 reset([earlierAccount]);
 let card=markup();
 assert.match(card,/<p class="visit-billing-headline">Check the charges<\/p>/,'the card asks staff to check, not to type');
 assert.match(card,/Filled in from the last visit\./,'and says where they came from');
 assert.match(card,/data-encounter-charges[^>]*>Check the charges<\/button>/,'its one button opens the table');
 // With nothing to fill in from, the card keeps the wording and the button it has always had.
 reset([emptyAccount]);
 card=markup();
 assert.match(card,/<p class="visit-billing-headline">Add charges<\/p>/);
 assert.match(card,/Add the procedures done at this encounter\./);
 assert.match(card,/data-encounter-charges[^>]*>Add charges<\/button>/);
 // An encounter whose charges are already being worked on is a different state, and is left alone: the
 // card does not speak of a fill-in for charges the practice already has.
 reset([currentDraft]);
 card=ctx.visitBillingCardMarkup({...addCharges(),state:'sign_visit',account:structuredClone(currentDraft)},owner);
 assert.ok(!card.includes('Filled in from the last visit'),'a visit with its own charges is not talked about as filled in');
 // Staff who cannot change charges are given nothing to press.
 reset([earlierAccount]);
 card=ctx.visitBillingCardMarkup(addCharges(),{canCreate:false,canWrite:false,claimsAllowed:false});
 assert.match(card,/Check the charges/);
 assert.doesNotMatch(card,/data-encounter-charges/,'no button for staff who cannot change charges');
 // A once-filled visit is not described as filled in when its table is blank again.
 reset([earlierAccount]);
 await openStep();
 click(openForm().querySelector('[data-charge-proposal-blank]'));
 card=markup();
 assert.match(card,/<p class="visit-billing-headline">Add charges<\/p>/,'after Start blank the card stops saying the charges are filled in');
 // The card's wording is true on screen: the step really does build the table.
 reset([earlierAccount]);
 card=markup();
 assert.match(card,/Check the charges/);
 form=await openStep();
 assert.equal(JSON.stringify(codes()),'["99213","J9270"]','the card\u2019s Check the charges leads to a table that is filled in');

 // ---- 6. plain words only ---------------------------------------------------------------
 const cardText=markup().replace(/<[^>]*>/g,' ');
 assert.doesNotMatch(cardText,/catalog|snapshot|payload|endpoint|schema|tenant|JSON/i,'the card says nothing developer-flavoured');
 reset([earlierAccount]);
 form=await openStep();
 const formText=openForm().outerHTML.replace(/<[^>]*>/g,' ');
 assert.doesNotMatch(formText,/proposed|payload|endpoint|schema|tenant|auto-?fill/i,'the table says nothing developer-flavoured');
 assert.match(fs.readFileSync('web/billing.js','utf8'),/Filled in from the encounter on /,'the quiet line is worded for staff');
 assert.match(fs.readFileSync('web/style.css','utf8'),/\.charge-table-proposal\{/,'the quiet line has its own quiet styling');

 console.log('PASS auto charges: filled in from the most recent earlier visit at practice prices with this encounter\u2019s diagnoses, an empty amount and a plain note where the price list has nothing, drug detail flagged for a check, never back after Start blank or an emptied table, never for an encounter that is not in progress or staff who cannot write, and a card that stops asking for hand entry');
})().catch(error=>{console.error(error);process.exit(1);});
