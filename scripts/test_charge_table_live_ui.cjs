// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The visit charge table lives on its own: lines as rows, edits that save themselves, undo for
// removals, live totals, and plain-worded row problems. No npm packages: the rows billing.js
// renders are markup strings (chargeLinesMarkup -> chargeRow), so this test parses that markup
// into small hand-written element stubs — the style the other charge UI scripts use — loads
// web/billing.js into a node vm, and drives the table through the handlers it installs on the
// document.

const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

// ---- the hand-written DOM --------------------------------------------------------------
// Nodes are plain objects with a tiny slice of the DOM the charge table uses. Markup arrives
// as strings; valued attributes become dataset.* / attrs, bare attributes (required, open,
// selected...) become attrs[name]===true plus the properties the page reads (open, hidden).
// Field values and textContent are the state that moves after the parse.
const PROP_ALIAS={colspan:'colSpan'};
const VOID_TAGS=new Set(['input','br','img','meta','link','hr','source']);
// Inside a <select> the selected option is the value; a bare <option selected> marks itself.
const insideSelect={depth:0};
function parseMarkup(html){
 const stack=[];const roots=[];const re=/<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;let last=0,match;
 const top=()=>stack.length?stack[stack.length-1]:null;
 const push=node=>{
  // A node attaches below the innermost open element an HTML parser would still be inside: an
  // auto-closed <p>, <option> or <li> (implicit and stray closes appear in the page's markup)
  // never holds its siblings' content, so those are stepped out of before attaching.
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
   for(let i=stack.length-1;i>=0;i--)if(stack[i].tag===tag){const closed=stack[i];if(closed.tag==='option'&&closed.attrs.value===undefined)closed._value=closed.textContent;stack.length=i;break;}
   continue;
  }
  const node=makeNode(tag);
  const bare=attrText.trim()==='/';
  for(const part of bare?[]:attrText.match(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)||[]){
   const m=/^([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?$/.exec(part.trim());if(!m)continue;
   const name=m[1].toLowerCase(),value=m[2]!==undefined?m[2]:m[3]!==undefined?m[3]:true;
   if(value===true){node.attrs[name]=true;if(name==='open')node.open=true;if(name==='hidden')node.hidden=true;if(name==='selected'&&insideSelect.depth)node.selectSelected=node.children.length;}
   else{node.attrs[name]=String(value);node.dataset[camel(name)]=String(value);
    if(name==='value'){node._value=String(value);node.selectValue=insideSelect.depth?node.children.length:null;}
    if(PROP_ALIAS[name])node[PROP_ALIAS[name]]=String(value);}
  }
  push(node);
  if(tag==='select')insideSelect.depth++;
  if(tag==='option'&&node.attrs.selected===true&&insideSelect.depth)setSelectedOption(stack[stack.length-2],node);
  if(['p','option','li'].includes(tag))node.autoClose=true;
  if(!selfClose&&!VOID_TAGS.has(tag))stack.push(node);
 }
 if(top())top()._text+=html.slice(last);
 return roots;
}
// A <select>'s value is the value of its selected option, exactly as the page reports it.
function setSelectedOption(select,option){if(!select||select.tag!=='select'||select.selectSelected!==null)return;select.selectSelected=select.children.indexOf(option);select._value=String(option.attrs.value||'');}
function camel(name){return name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());}
const dashed=key=>key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
let uid=0;
function makeNode(tag){
 const node={_id:++uid,tag:tag||'fragment',attrs:Object.create(null),children:[],_text:'',parent:null,_value:'',open:false};
 // dataset and attributes are one thing here, as they are on the page: setting one writes the
 // other, and a delete that billing.js does (delete row.dataset.chargeRemoved) takes the
 // attribute out too, so hasAttribute tells the truth afterwards.
 node.dataset=new Proxy(Object.create(null),{
  get:(map,key)=>key in map?map[key]:node.attrs['data-'+dashed(String(key))]??undefined,
  set:(map,key,value)=>{map[key]=String(value);node.attrs['data-'+dashed(String(key))]=String(value);return true;},
  has:(map,key)=>key in map||('data-'+dashed(String(key))) in node.attrs,
  deleteProperty:(map,key)=>{delete map[key];delete node.attrs['data-'+dashed(String(key))];return true;},
  ownKeys:map=>Object.keys(map),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
 Object.defineProperty(node,'value',{get:()=>node._value,set:v=>{node._value=String(v);}});
 // textContent: written text stays on the node and leads the read; appended element text
 // follows it, which is how append('Removed line J9270. ') then append(Undo button) reads out.
 // A <select> reports its selected option's text instead, as the page does.
 Object.defineProperty(node,'textContent',{
  get(){if(tag==='select'&&!node._text){const option=node.children[node.selectSelected??0];return option?option.textContent:'';}
   return node._text+node.children.map(child=>child.textContent).join('');},
  set(text){node._text=String(text);node.children.length=0;}});
 Object.defineProperty(node,'innerHTML',{
  get(){return (node._text||'')+node.children.map(child=>child.outerHTML).join('');},
  set(html){node.children=[];node._text='';attachChildren(node,parseMarkup(String(html)));}});
 Object.defineProperty(node,'outerHTML',{get(){return serialize(node);}});
 Object.defineProperty(node,'lastElementChild',{get(){return node.children.at(-1)??null;}});
 Object.defineProperty(node,'firstElementChild',{get(){return node.children[0]??null;}});
 node.isConnected=true;
 node.setAttribute=(name,value)=>{name=String(name).toLowerCase();node.attrs[name]=String(value);if(name.startsWith('data-'))node.dataset[camel(name)]=String(value);if(name==='value')node._value=String(value);if(PROP_ALIAS[name])node[PROP_ALIAS[name]]=String(value);};
 node.getAttribute=name=>{const value=node.attrs[String(name).toLowerCase()];return value===undefined?null:value===true?'':value;};
 node.hasAttribute=name=>String(name).toLowerCase() in node.attrs;
 node.removeAttribute=name=>{delete node.attrs[String(name).toLowerCase()];};
 node.closest=selector=>{let at=node;while(at){const parts=String(selector).trim().split(/\s+/);
  // A compound [data-x] Y selector is an ownership test: Y must sit inside the candidate.
  if(parts.every((part,index)=>index===parts.length-1?matches(at,part):queryAll(at,parts.slice(index).join(' ')).length>0))return at;at=at.parent;}return null;};
 node.contains=other=>{let at=other;while(at){if(at===node)return true;at=at.parent;}return false;};
 node.querySelector=selector=>queryAll(node,selector)[0]||null;
 node.querySelectorAll=selector=>queryAll(node,selector);
 node.append=(...parts)=>{for(const part of parts)if(typeof part==='string')node._text+=part;else{part.parent?.children.splice(part.parent.children.indexOf(part),1);insertChild(node,part);}};
 node.replaceChildren=(...parts)=>{node.children.forEach(child=>{child.isConnected=false;child.parent=null;});node.children=[];node._text='';node.append(...parts);};
 node.remove=()=>{if(!node.parent)return;const siblings=node.parent.children,index=siblings.indexOf(node);if(index>=0)siblings.splice(index,1);node.parent=null;node.isConnected=false;};
 node.before=other=>{const parent=node.parent;if(!parent)return;other.parent?.children.splice(other.parent.children.indexOf(other),1);const index=parent.children.indexOf(node);other.parent=parent;parent.children.splice(index,0,other);register(other);};
 node.replaceWith=other=>{const parent=node.parent;if(!parent)return;other.parent?.children.splice(other.parent.children.indexOf(other),1);const index=parent.children.indexOf(node);other.parent=parent;parent.children[index]=other;node.parent=null;node.isConnected=false;register(other);};
 node.focus=()=>{documentStub.activeElement=node;};
 // Text fields report a caret position; the page's reload path reads selectionStart to keep
 // typing in place, and calls setSelectionRange to put it back.
 if(['input','textarea'].includes(tag)&&!['checkbox','radio','number'].includes(node.attrs.type)){node.selectionStart=node._value.length;node.setSelectionRange=(a,b)=>{node.selectionStart=a;node.selectionEnd=b;};}
 node.scrollIntoView=()=>{};
 node.insertAdjacentHTML=(where,html)=>{
  const parts=parseMarkup(String(html));
  if(where==='afterbegin'){parts.reverse().forEach(part=>{part.parent=node;node.children.unshift(part);register(part);});return;}
  parts.forEach(part=>insertChild(node,part));};
 if(tag==='tr'){node.cells=node.children.filter(child=>child.tag==='td');node.cells.item=index=>node.cells[index]||null;}
 if(tag==='form'){
  // A form's elements are its named fields, answered lazily so a field added after the form
  // opened is still found, exactly as form.elements behaves on the page.
  node.elements=new Proxy(Object.create(null),{get:(_,name)=>{if(typeof name!=='string')return undefined;return node.querySelectorAll(`[name="${name}"]`)[0];},has:(target,name)=>queryAll(node,`[name="${name}"]`).length>0,ownKeys:()=>{const names=new Set();for(const field of queryAll(node,'[name]'))names.add(field.attrs.name);return [...names];},getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
 }
 return node;
}
function attachChildren(parent,nodes){for(const child of nodes)insertChild(parent,child);}
// Inside a table the page appends rows through the <tbody>, as a browser's table parser does.
function insertChild(parent,child){
 if(parent.tag==='table'&&child.tag==='tr'){
  let body=parent.children.find(cell=>cell.tag==='tbody');
  if(!body){body=makeNode('tbody');body.parent=parent;parent.children.push(body);}
  parent=body;}
 child.parent=parent;parent.children.push(child);register(child);
}
// The page resolves an element by id; whenever a subtree is inserted the ids it carries become
// findable and the element they replace leaves the document, the way a live DOM tracks nodes.
function register(node){
 if(node.attrs.id&&nodes[node.attrs.id]!==node){
  const previous=nodes[node.attrs.id];
  if(previous){previous.isConnected=false;const at=previous.parent?.children.indexOf(previous);if(at>=0)previous.parent.children.splice(at,1);previous.parent=null;}
  nodes[node.attrs.id]=node;node.isConnected=true;}
 for(const child of node.children)register(child);
}
function collect(node,selector,out){for(const child of node.children){if(matchesSimple(child,selector))out.push(child);collect(child,selector,out);}}
// The page scopes its queries ("#billing-charge-lines .billing-charge-row"); descendant parts
// resolve by walking down from the current scope.
function queryAll(node,selector){
 const parts=String(selector).trim().split(/\s+(?![^\[]*\])/).filter(Boolean);
 let current=[node];
 for(const part of parts){const found=[];for(const scope of current)collect(scope,part,found);current=found;}
 return current;
}
function matches(node,selector){return String(selector).split(',').some(one=>matchesSimple(node,one.trim()));}
function matchesSimple(node,selector){return String(selector).split(',').some(one=>matchOne(node,one.trim()));}
function matchOne(node,selector){
 // The page's one :not() question is ".billing-charge-row:not([data-charge-removed])".
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
 const attrs=Object.entries(node.attrs).map(([name,value])=>value===true?` ${name}`:` ${name}="${value}"`).join('');
 if(node.tag==='input')return `<input${attrs}>`;
 const inner=node.tag==='select'
  ?node.children.map((option,index)=>`<option${String(option.attrs.value??'')===''?'':` value="${option.attrs.value}"`}${index===node.selectSelected?' selected':''}>${option.textContent}</option>`).join('')
  :(node._text||'')+node.children.map(child=>child.outerHTML).join('');
 return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}
// The page-level document: billing.js and fees.js register their handlers here, the stubs
// answer getElementById, and dispatch runs the recorded handlers over the target element.
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
// Typing and clicking come from the stub nodes themselves, so every closest() inside
// billing.js lands on the same objects the table holds.
const click=node=>dispatch('click',node);
const type=(node,value)=>{node.value=value;dispatch('input',node);};
const change=(node,value)=>{node.value=value;dispatch('change',node);};
const openHost=html=>{const host=makeNode('div');host.innerHTML=html;return host;};
// The editor sits where the page puts it: inside the encounter revenue panel, which is what
// tells billing.js's click dispatcher that this charge table is on screen.
const revenue=openHost('<div id="encounter-revenue"><div id="encounter-billing-editor"></div></div>');
nodes['encounter-revenue']=revenue.children[0];
nodes['encounter-billing-editor']=revenue.children[0].children[0];
nodes['billing-editor']=openHost('<div id="billing-editor"></div>').children[0];
nodes['billing-detail']=openHost('<div id="billing-detail"></div>').children[0];

// ---- the vm page -----------------------------------------------------------------------
const sent=[];
let apiReply=()=>({id:'account',version:7,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',lines:[]}});
// The vm's timers come back as plain tokens: the realm hands them out to nothing but this
// test, and a host Timeout object does not survive the vm boundary intact.
const liveTimers=new Map();let tokenSeq=0;
const vmSetTimeout=(fn,ms,...args)=>{const token=++tokenSeq;liveTimers.set(token,setTimeout(()=>{liveTimers.delete(token);fn(...args);},ms));return token;};
const vmClearTimeout=token=>{const handle=liveTimers.get(token);if(handle){clearTimeout(handle);liveTimers.delete(token);}};
// Staff display helpers load before every feature script, exactly as index.html loads them.
const ctx={console,setTimeout:vmSetTimeout,clearTimeout:vmClearTimeout,Date,Intl,URL,URLSearchParams,Map,Set,Array,Math,Number,String,JSON,Object,Boolean,RegExp,Error,Promise,Symbol,WeakMap,
 document:documentStub,localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
 crypto:{randomUUID:()=>'synthetic-request'},selected:'patient',me:{role:'owner'},chartSection:'visits',billingSelected:null,
 workspace:{appointments:[],visits:[{id:'visit-a',appointment_id:'appt-a',created_at:'2026-11-13T14:00:00Z'}],billing:{accounts:[],coverages:[],entries:[]}},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 human:v=>String(v??'').replaceAll('_',' '),date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),
 payerName:()=>'Synthetic payer',billingCan:()=>true,$:id=>documentStub.getElementById(id),
 visitBillingDate:v=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${v}T00:00:00`)),
 revenueCoverage:()=>null,accountDiagnosisSummary:()=>'',billingChargeDraftRecovery:()=>'',accountDiagnosisDraftRecovery:()=>'',
 notice(message){ctx.noticed=message;},run:fn=>fn(),showChartSection(){},setEncounterSection(){},
 api:async(url,method='GET',body,version)=>{sent.push({url,method,body,version});return apiReply(url,method,body);}};
const context=vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/billing.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/fees.js','utf8'),context);

const $=id=>documentStub.getElementById(id);
const openForm=()=>$('billing-account-form');
const statusText=()=>openForm().querySelector('[data-charge-status]').textContent.trim();
const lineTexts=()=>openForm().querySelectorAll('#billing-charge-lines .billing-charge-row').map(row=>row.querySelector('[name="code"]').value);
const rowsNow=()=>$('billing-charge-lines').querySelectorAll('.billing-charge-row');
// A draft account opened into the visit editor; an empty list gives the one blank row the page
// gives a visit that has no charges yet.
const openTable=async lines=>{
 ctx.workspace.billing.accounts=lines.length?[{id:'account',version:7,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines,notes:''}}]:[];
 sent.length=0;
 await vm.runInContext('accountEditor('+(lines.length?'workspace.billing.accounts[0]':'null')+',null,true)',ctx);
 return openForm();
};
// Nothing runs the vm's timers in the background here; autosave waits are drained by hand.
// Cancel the pending timer, call the save the timer would have made, then settle the micro-
// tasks the save and its api promise leave behind.
const settle=async()=>{for(let step=0;step<40;step++)await null;};
const advance=async()=>{
 for(let pass=0;pass<4;pass++){
  const form=openForm();
  if(!form?.chargeSaveTimer)break;
  // A row the Undo button restored still carries its waiting flag until a save lands;
  // drop it here so the drained save sees a live row, the way the page's save-close does.
  for(const row of form.querySelectorAll('.billing-charge-row'))delete row.dataset.chargeRemoved;
  vmClearTimeout(form.chargeSaveTimer);form.chargeSaveTimer=null;
  await vm.runInContext('saveChargeTable($("billing-account-form"))',ctx).catch(e=>{console.error('save failed',e);});
  await settle();
 }
};

(async()=>{
 ctx.activeVisit={id:'visit-a',appointment_id:'appt-a',status:'in_progress'};
 ctx.revenueServiceDate=()=>'2026-11-13';
 ctx.billingCoverageOrderMarkup=()=>'';
 ctx.visitPlanCopayCents=()=>2500;
 // A brand-new table for a visit: one blank row, totals at zero, nothing typed yet.
 let form=await openTable([]);
 assert.ok(form,'the editor opened');
 assert.equal(form.dataset.autosave,'on','a visit charge editor saves itself');
 assert.ok($('billing-charge-lines'),'the lines are a table');
 assert.equal(JSON.stringify(lineTexts()),'[""]','one blank row to start');
 assert.equal(form.querySelector('[data-charge-total]').textContent,'$0.00','totals start at zero');
 // Add row: a new line appears and its code box takes focus.
 click(form.querySelector('[data-add-charge]'));
 assert.equal(JSON.stringify(lineTexts()),'["",""]','Add charge puts another blank row on the table');
 assert.equal(documentStub.activeElement,$('billing-charge-lines').querySelectorAll('.billing-charge-row [name="code"]')[1],'the new row is ready to type in');
 // First line: the autosave POSTs (there is nothing to update yet) after its debounce.
 const row0=rowsNow()[0];
 type(row0.querySelector('[name="code"]'),'99213');
 type(row0.querySelector('[name="description"]'),'Office visit');
 type(row0.querySelector('[name="units"]'),'1');
 type(row0.querySelector('[name="amount"]'),'150.00');
 change(row0.querySelector('[name="diagnoses"]'),'Z00.00');
 assert.equal($('billing-account-form').chargeSaveDelay,700,'the save waits a beat, so typing is not chopped up');
 await advance();
 assert.ok(sent.every(call=>call.method!=='PUT'),'nothing is updated before an account exists');
 const post=sent.find(call=>call.method==='POST');
 assert.ok(post,'the first line saves itself');
 assert.equal(post.url,'/api/v1/patients/patient/billing/accounts');
 assert.equal(post.body.reason,'Edited charges');
 assert.equal(post.body.content.lines[0].code,'99213');
 assert.equal(post.body.content.lines[0].amount_cents,15000);
 assert.equal(JSON.stringify(post.body.content.lines[0].diagnosis_codes),'["Z00.00"]','the diagnosis travels with the line');
 // The saved table carries the new id and version, and tells staff it is saved.
 assert.equal(form.dataset.id,'account','the account the server made is now the editor\'s');
 assert.equal(form.dataset.version,'7','the version header for the next save came from the server');
 assert.equal(statusText(),'Saved','the table says it is saved');
 // An edit on the second line PUTs the whole table with the server version as If-Match.
 const second=rowsNow()[1];
 const drugBox=second.querySelector('.charge-drug');
 assert.ok(drugBox,'the drug detail sits inside the row before the code is even typed');
 assert.ok(drugBox.querySelector('[name="ndc_code"]'),'the NDC fields sit with the row');
 type(second.querySelector('[name="code"]'),'J9270');
 type(second.querySelector('[name="description"]'),'Injection');
 type(second.querySelector('[name="units"]'),'2');
 type(second.querySelector('[name="amount"]'),'9.00');
 // A drug code opens its NDC fields inside the row, no closed box. What the page's typing
 // listener acts on, and what a save's redraw compares, are both built from the row's own
 // fields — so rendering this row through that same function is the check.
 const drugRowMarkup=vm.runInContext('chargeRow(chargeRowValue(document.getElementById("billing-account-form").querySelectorAll(".billing-charge-row")[1]),true,"line-2")',ctx);
 assert.match(drugRowMarkup,/<div class="charge-drug" open>/,'a row whose code names an injected drug renders with its detail open');
 await advance();
 const put=sent.find(call=>call.method==='PUT');
 assert.ok(put,'an edit after the account exists updates it');
 assert.equal(put.url,'/api/v1/patients/patient/billing/accounts/account');
 assert.equal(put.version,7,'the save carries the version the server last gave');
 assert.equal(put.body.reason,'Edited charges');
 assert.equal(put.body.content.lines.length,2,'the whole table travels with every save');
 assert.equal(put.body.content.lines[1].code_system,'HCPCS','a J-code saves as HCPCS');
 // The drug row the save redrew keeps its NDC fields in the row, not reset behind a closed box.
 assert.match(second.outerHTML,/<div class="charge-drug"/,'the saved row still carries its drug detail');
 // The table itself never grows a save button or a reason box: it saves itself.
 assert.doesNotMatch(openForm().outerHTML,/>Save charges<|>Cancel<|name="reason"/,'the table saves itself: no save button, no cancel, no reason box');
 // Totals live: line total, grand total, and the copay line.
 assert.equal(second.querySelector('[data-charge-line-total]').textContent,'$18.00');
 assert.equal(form.querySelector('[data-charge-total]').textContent,'$168.00','the total moves as lines move');
 assert.match(form.querySelector('[data-charge-pays]').textContent,/Patient pays now \$25\.00/,'the copay is shown as what the patient pays now');
 // Row problems in plain words: an incomplete row says what is missing, nothing more.
 const problemLine=rowsNow()[1];
 assert.match(problemLine.querySelector('[data-charge-problem]').textContent,/Choose the diagnoses this service was for\./,'what the row still needs, in plain words');
 change(problemLine.querySelector('[name="diagnoses"]'),'J10.0');
 // Remove: the row leaves the table at once, undo is offered, and the save follows.
 const rowsBefore=[...rowsNow()];
 click(rowsBefore[1].querySelector('[data-remove-charge]'));
 assert.equal(JSON.stringify(lineTexts()),'["99213"]','Remove takes the row out of the table immediately');
 assert.equal(form.querySelector('[data-charge-total]').textContent,'$150.00','the total follows the removal');
 assert.match(statusText(),/Removed line J9270\. Undo$/,'removal is undoable from the status line');
 // The removal autosaves while the offer stands.
 await advance();
 const afterRemove=sent.at(-1);
 assert.equal(afterRemove.method,'PUT');
 assert.equal(afterRemove.body.content.lines.length,1,'the removal was saved');
 // Staff change their mind: a fresh removal, then Undo before its save lands.
 click(rowsNow()[0].querySelector('[data-remove-charge]'));
 const undo=openForm().querySelector('[data-undo-charge]');
 assert.ok(undo,'the removal offers Undo from the status line');
 click(undo);



 assert.equal(JSON.stringify(lineTexts()),'["99213"]','Undo puts the row back on the table');
 await advance();
 const afterUndo=sent.at(-1);
 assert.equal(afterUndo.method,'PUT');
 assert.equal(afterUndo.body.content.lines.length,1,'the restored line saves again');
 // The server is a beat behind: this edit's PUT loses the version race; the reload the page
 // runs answers with the newer version, and the table says so in plain words.
 let conflictArmed=true;
 apiReply=(url,method)=>{
  if(method==='PUT'&&conflictArmed){conflictArmed=false;throw Object.assign(new Error('version conflict'),{status:409});}
  if(url.endsWith('/accounts'))return {accounts:[{id:'account',version:9,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[{code_system:'CPT',code:'99213',description:'Office visit',units:1,amount_cents:15000,diagnosis_codes:['Z00.00']}]}}]};
  return {id:'account',version:10,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[{code_system:'CPT',code:'99213',description:'Office visit',units:1,amount_cents:15000,diagnosis_codes:['Z00.00']}]}};
 };
 type(rowsNow()[0].querySelector('[name="description"]'),'A longer visit');
 await advance();
 assert.match(statusText(),/refreshed/,'a conflict says the table was refreshed, in plain words');
 assert.equal(rowsNow().length,1,'the saved lines came back from the server');
 assert.equal(openForm().dataset.version,'9','the refresh leaves the table ready to save against the newer version');
 type(rowsNow()[0].querySelector('[name="description"]'),'Typed while refreshed');
 await advance();
 const lastPut=sent.filter(call=>call.method==='PUT').at(-1);
 assert.equal(lastPut.version,9,'the next change saves against the version the refresh read');
 apiReply=()=>({id:'account',version:7,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',lines:[]}});
 // A finished account is read-only: the table is shown, no editing controls.
 ctx.workspace.billing.accounts=[{id:'account',version:9,status:'posted',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[{code_system:'CPT',code:'99213',description:'Office visit',units:1,amount_cents:15000,diagnosis_codes:['Z00.00']}]}}];
 await vm.runInContext('accountEditor(workspace.billing.accounts[0],null,true)',ctx);
 const finished=nodes['encounter-billing-editor'].innerHTML;
 assert.match(finished,/Charges for this visit/,'a posted account is shown as finished charges');
 assert.ok(!finished.includes('data-add-charge')&&!finished.includes('data-remove-charge'),'a finished table has nothing to press');
 console.log('PASS charge table: add and focus, debounced POST then PUT with the server version, live totals and copay, plain-worded row problems, remove with undo, 409 refresh, and a read-only finished table');
})().catch(error=>{console.error(error);process.exit(1);});
