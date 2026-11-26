// SPDX-License-Identifier: AGPL-3.0-only
// Type-as-you-go payers and pharmacies. web/typeahead.js is the shared picker; each screen
// hands it the records, or the search, it already had. These checks run the real picker and
// the real screens against a small stub DOM (plain node + vm, no jsdom).
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const tick=async()=>{for(let n=0;n<12;n++)await Promise.resolve();};
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

// ---------------------------------------------------------------------------
// A small DOM: parsing, parent links, events, ids and FormData.
// ---------------------------------------------------------------------------
const VOID=new Set(['input','br','img','meta','link','hr','col','source','wbr']);
// Attributes a browser also exposes as properties.
const PROPERTIES={id:'_id',name:'_name',value:'_value',type:'_type',disabled:'_disabled',readOnly:'_readOnly',hidden:'_hidden',required:'_required'};
const ATTRIBUTES={id:'id',name:'name',value:'value',type:'type',disabled:'disabled',readOnly:'readonly',hidden:'hidden',required:'required'};

// Real element semantics for the two things the screens rely on. setAttribute must reflect into
// dataset, and dataset must be a live view of the data-* attributes: assigning through one is
// how a page clears state through the other.
function setAttribute(node,key,value){
 node.attrs[key]=String(value);
 const property=Object.keys(PROPERTIES).find(name=>ATTRIBUTES[name]===key);
 if(property)node[property]=String(value);
 if(key.startsWith('data-'))node.dataset[camel(key.slice(5))]=String(value);
 if(key==='id')document.ids.set(String(value),node);
}
function removeAttribute(node,key){
 delete node.attrs[key];
 const property=Object.keys(PROPERTIES).find(name=>ATTRIBUTES[name]===key);
 if(property)node[property]=key==='hidden'||key==='required'?false:'';
 if(key.startsWith('data-'))delete node.dataset[camel(key.slice(5))];
}
const camel=key=>key.replace(/-(\w)/g,(_,c)=>c.toUpperCase());
// dataset reads and writes the same data-* attributes a page's would.
function datasetOf(node){
 return new Proxy(node.dataset,{
  get(target,key){
   if(typeof key!=='string')return undefined;
   if(key in target)return target[key];
   const attribute='data-'+key.replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase());
   return attribute in node.attrs?node.attrs[attribute]:undefined;
  },
  set(target,key,value){target[key]=String(value);return true;},
  deleteProperty(target,key){delete target[key];return true;},
  has(target,key){
   if(key in target)return true;
   return ('data-'+String(key).replace(/[A-Z]/g,letter=>'-'+letter.toLowerCase())) in node.attrs;
  },
 });
}
// Each workspace gets its own global object, in place of a browser window. A screen's top-level
// `function foo()` lands on it, and a picker loaded into the same workspace can then call it.
// Following the live tree, as the picker and the screens do, rather than a flat id table, keeps
// a replaced form from answering with the box it used to hold.
function byIdIn(root,id){
 let found=null;
 const walk=node=>{for(const child of node.children){if(found)return;if((child.attrs.id||child._id)===id){found=child;return;}walk(child);}};
 walk(root);
 return found;
}
function stubDom(){
 const document={ids:new Map()};
 // One dispatch path for the whole document: a node's own handlers first, then its ancestors,
 // then the document's delegated listeners, the way a real event travels.
 function dispatchEvent(event){
  event.target=event.target||document.body;
  // A real UIEvent already carries preventDefault; the flag it sets is what callers read back.
  let stopped=false;
  const stop=()=>{stopped=true;};
  const check=()=>{if(event._stopped)stopped=true;};
  const path=[];for(let current=event.target;current;current=current.parentElement)path.push(current);
  for(const node of path){
   for(const handler of [...(node.listeners?.get(event.type)||[])]){handler(event);check();if(stopped)return !event.defaultPrevented;}
  }
  for(const handler of [...(document.listeners.get(event.type)||[])]){handler(event);check();if(stopped)break;}
  return !event.defaultPrevented;
 }
 document.dispatch=event=>{const full=eventObject(event);dispatchEvent(full);return full;};
 // Every event handed to a handler carries the UIEvent surface a handler expects.
 // Every event a handler receives carries the UIEvent surface, with its own preventDefault and
 // its own defaultPrevented flag.
 function eventObject(fields){
  const event={...fields};
  event.defaultPrevented=false;
  event.preventDefault=()=>{event.defaultPrevented=true;};
  event.stopPropagation=()=>{event._stopped=true;};
  event.stopImmediatePropagation=()=>{event._stopped=true;};
  return event;
 }
 function make(tag,attrs={}){
  const node={tag,tagName:tag.toUpperCase(),attrs,children:[],parent:null,dataset:{},isConnected:true,_html:'',textContent:''};
  node.dataset=datasetOf(node);
  node._id=attrs.id||'';node._name=attrs.name||'';node._value=attrs.value||'';node._type=attrs.type||'';
  node._disabled=false;node._readOnly=false;node._hidden=Object.hasOwn(attrs,'hidden');node._required=Object.hasOwn(attrs,'required');
  for(const [property,slot] of Object.entries(PROPERTIES)){
   Object.defineProperty(node,property,{
    get(){return node[slot];},
    set(value){
     node[slot]=typeof value==='string'?value:!!value;
     const attribute=ATTRIBUTES[property];
     if(value===false||value===null||value===undefined)delete node.attrs[attribute];
     else node.attrs[attribute]=value===true?'':String(value);
     if(property==='id'&&value)document.ids.set(String(value),node);
    },
    configurable:true,enumerable:true,
   });
  }
  if(attrs.id)document.ids.set(attrs.id,node);
  node.listeners=new Map();
  node.addEventListener=(type,handler)=>{node.listeners.set(type,[...(node.listeners.get(type)||[]),handler]);};
  node.removeEventListener=(type,handler)=>{node.listeners.set(type,(node.listeners.get(type)||[]).filter(item=>item!==handler));};
  // A browser event object is fresh for every dispatch, and its preventDefault is its own.
  node.dispatch=event=>{const full=eventObject({...event,target:node});dispatchEvent(full);return full;};
  node.matches=selector=>{
   for(const part of selector.split(',')){
    const trimmed=part.trim();
    const attribute=/^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(trimmed);
    if(attribute){if(!(attribute[1] in node.attrs))continue;if(attribute[2]!==undefined&&node.attrs[attribute[1]]!==attribute[2])continue;return true;}
    const tagged=/^([a-zA-Z][\w-]*)?\[([\w-]+)(?:="([^"]*)")?\]$/.exec(trimmed);
    if(tagged){if(tagged[1]&&node.tag!==tagged[1])continue;if(!(tagged[2] in node.attrs))continue;if(tagged[3]!==undefined&&node.attrs[tagged[2]]!==tagged[3])continue;return true;}
    if(trimmed.startsWith('.')){if((node.attrs.class||'').split(/\s+/).includes(trimmed.slice(1)))return true;continue;}
    if(trimmed===node.tag)return true;
   }
   return false;
  };
  // As in a browser, closest() considers the element itself before its ancestors.
  node.closest=selector=>{for(let current=node;current;current=current.parentElement)if(current.matches(selector))return current;return null;};
  node.querySelectorAll=selector=>{const found=[];const walk=current=>{for(const child of current.children){if(child.matches(selector))found.push(child);walk(child);}};walk(node);return found;};
  node.querySelector=selector=>node.querySelectorAll(selector)[0]||null;
  node.previousElementSibling=null;node.nextElementSibling=null;
  node.insertAdjacentElement=(position,sibling)=>{
   sibling.parentElement=sibling.parent=node;

   const index=position==='afterbegin'?0:node.children.length;
   node.children.splice(index,0,sibling);
   if(sibling.attrs?.id)document.ids.set(sibling.attrs.id,sibling);
   return sibling;
  };
  node.remove=()=>{if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(child=>child!==node);};
  node.replaceWith=replacement=>{
   const parent=node.parentElement;if(!parent)return;
   parent.children=parent.children.map(child=>child===node?replacement:child);
   replacement.parentElement=parent;
   if(replacement.attrs?.id)document.ids.set(replacement.attrs.id,replacement);
  };
  node.cloneNode=()=>make(node.tag,{...node.attrs});
  node.setAttribute=(key,value)=>setAttribute(node,key,value);
  node.getAttribute=key=>key in node.attrs?node.attrs[key]:null;
  node.removeAttribute=key=>removeAttribute(node,key);
  node.hasAttribute=key=>key in node.attrs;
  node.focus=()=>{document.activeElement=node;};
  node.blur=()=>{node.dispatch({type:'blur'});};
  node.scrollIntoView=()=>{};
  node.click=()=>node.dispatch({type:'click'});

  Object.defineProperty(node,'innerHTML',{
   get(){return node._html;},
   set(html){node._html=html;node.children=[];node.textContent='';parseInto(html,node,make);},
   configurable:true,
  });
  Object.defineProperty(node,'nodeType',{get(){return 1;},configurable:true});
  return node;
 }
 function parseInto(html,parent,factory){
  const pattern=/<(\/)?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>|([^<]+)/g;
  const stack=[parent];let match;
  while((match=pattern.exec(html))){
   const [,slash,tag,attributes,selfClosing,text]=match;
   if(text!==undefined){if(text.trim())stack[stack.length-1].textContent+=text;continue;}
   if(slash){for(let depth=stack.length-1;depth>0;depth--)if(stack[depth].tag===tag){stack.length=depth;break;}continue;}
   const attrs={};const attrPattern=/([\w-]+)(?:\s*=\s*"([^"]*)")?/g;let attr;
   while((attr=attrPattern.exec(attributes||'')))attrs[attr[1]]=attr[2]??'';
   const node=factory(tag,attrs);
   const container=stack[stack.length-1];
   const previous=container.children[container.children.length-1]||null;
   node.parentElement=container;node.parent=container;
   if(previous){previous.nextElementSibling=node;node.previousElementSibling=previous;}
   container.children.push(node);
   if(!VOID.has(tag)&&!selfClosing)stack.push(node);
  }
 }
 const body=make('body');
 document.body=body;
 // A page writes through document.documentElement too; both names reach the same live tree.
 document.documentElement=body;
 document.createElement=tag=>make(tag);
 document.getElementById=id=>byIdIn(body,id);
 document.contains=node=>{for(let current=node;current;current=current.parentElement)if(current===body)return true;return false;};
 document.querySelectorAll=selector=>body.querySelectorAll(selector);
 document.querySelector=selector=>body.querySelector(selector);
 Object.defineProperty(document,'innerHTML',{get(){return body.innerHTML;},set(html){body.innerHTML=html;}});
 document.insertAdjacentHTML=(position,html)=>{
  const container=document.createElement('div');
  container.innerHTML=html;
  for(const child of [...container.children])body.insertAdjacentElement(position==='afterbegin'?'afterbegin':'beforeend',child);
 };
 document.listeners=new Map();
 document.addEventListener=(type,handler)=>{document.listeners.set(type,[...(document.listeners.get(type)||[]),handler]);};
 document.removeEventListener=(type,handler)=>{document.listeners.set(type,(document.listeners.get(type)||[]).filter(item=>item!==handler));};
 // Clicks and keys bubble from the target up through its ancestors, then reach the document
 // listeners, so the picker's delegated handlers see them the way the page does.
 document.activeElement=body;
 document.readyState='loading';
 // A browser script tag gives every file one shared global; the vm context object only sees
 // var declarations, so the screens' and the picker's entry points are published by name.
 document.load=(context,file)=>{
  vm.runInContext(fs.readFileSync('web/'+file,'utf8'),context,{filename:'web/'+file});
 };
 // As a page's FormData: walks the form for named fields, reads what a box holds now, and stops
 // at nodes with no children of their own.
 // As a page's FormData: every named field that lives inside the form, read from the live tree
 // so a box the screen re-rendered is still found, and in document order.
 // As a page's FormData: every named field inside the form, in document order.
 document.FormData=class FormData{
  constructor(form){
   this.rows=[];
   if(!form)return;
   const walk=current=>{
    for(const child of current.children||[]){
     if((child.tag==='input'||child.tag==='textarea')&&child.name)this.rows.push([child.name,child.value??'']);
     walk(child);
    }
   };
   walk(form);
  }
  [Symbol.iterator](){return this.rows[Symbol.iterator]();}
  get(key){return(this.rows.find(([name])=>name===key)||[])[1]??'';}
 };
 return {document,body};
}

// Runs the picker plus one or more screens against a fresh stub DOM.
function workspace(files,extra={}){
 // The stub DOM comes first, so the screens find their hosts through the same document and the
 // same $() the page gives them, whatever order their own setup runs in.
 const dom=stubDom();
 // A queue, not a map: clearTimeout must cancel exactly the timeout it is named for, the way a
 // page's does, and two screens can hold a pending timer at the same time.
 const queue=[];let timerId=0;
 const notices=[],calls=[];
 const setTimer=(fn,delay)=>{const entry={fn,delay,id:++timerId};queue.push(entry);return entry.id;};
 const clearTimer=id=>{const index=queue.findIndex(entry=>entry.id===id);if(index>=0)queue.splice(index,1);};
 // The window's ordinary furniture: the DOM, the stub timers, and the page's copy helpers.
 const window={
  document:dom.document,FormData:dom.document.FormData,console,
  esc,human:value=>String(value||'').replaceAll('_',' '),date:value=>String(value||''),
  money:cents=>String((Number(cents)||0)/100),dollars:cents=>String((Number(cents)||0)/100),
  setTimeout:setTimer,clearTimeout:clearTimer,
  MutationObserver:class{constructor(fn){this.fn=fn;}observe(){}disconnect(){}},
  Event:class{constructor(type,options={}){this.type=type;Object.assign(this,options);}},
  crypto:{randomUUID:()=>'synthetic-request'},
  $:id=>dom.document.getElementById(id),
  billingWrite:()=>true,
  payerName:id=>(window.billingPayers||[]).find(payer=>payer.id===id)?.content.name||'Unavailable payer',
  showChartSection(){},openBillingEditor(){},enableCoverageSubmit(){},
  // Mount the chart detail's form as the real sheet does when it opens.
  chartRecordTemplate:(id,html)=>html,
 };
 // A page supplies a great many names its screens may read without asking. Anything the test has
 // not supplied reads as a do-nothing stand-in rather than throwing, so a screen never fails for
 // a reason unrelated to the picker under test.
 // A page provides a great many names its screens may read without asking. Anything the test has
 // not supplied reads as a do-nothing stand-in rather than throwing, so a screen never fails for
 // a reason unrelated to the picker under test. The built-ins are supplied rather than stubbed:
 // a screen really does construct a Set or format with Intl, and a stub would only hide that.
 const builtIns={Object,Array,String,Number,Boolean,JSON,Math,Date,Error,TypeError,RangeError,RegExp,
  Promise,Symbol,Reflect,Proxy,Map,Set,WeakMap,WeakSet,WeakRef,FinalizationRegistry,
  Intl,URLSearchParams,URL,encodeURIComponent,decodeURIComponent,isNaN,parseInt,parseFloat};
 const page=new Proxy(window,{
  get(target,key){
   if(typeof key==='symbol'||key==='then')return undefined;
   if(key in target)return target[key];
   if(key in builtIns)return builtIns[key];          // the language, as window hands it over
   if(/^[A-Z]/.test(String(key)))return undefined;   // a constructor the page never defines
   return target[key]=()=>'';                        // a pane or helper that does nothing here
  },
  has(){return true;},
 });
 // Runs whatever a debounced search was waiting on, then lets the answer land.
 const settle=async()=>{
  const pending=queue.splice(0);
  for(const timer of pending){try{timer.fn();}catch(error){if(process.env.DBG)console.log('SETTLE timer threw',error.message);}}
  await tick();await tick();
 };
 // The scripts run against the vm context itself, so a screen's top-level declarations land on
 // the shared global exactly as a script tag lands them on window — which is how the picker
 // reaches the screen's payer list and the screens reach the picker's helpers. The context object
 // also inherits the page's furniture, so a name the test has not supplied still resolves.
 const sandbox=Object.create(page);
 vm.createContext(sandbox);
 // Seeding helpers for state a screen keeps in a file-private const. The script's own `let`
 // bindings live in the shared global lexical scope, so the test reaches them the same way a
 // second script tag in the page would: a script running in the same context.
 sandbox.seedPrescribing=(patient,state)=>vm.runInContext('(p,st)=>{prescribingStates.set(p,st)}',sandbox)(patient,state);
 sandbox.seedPrescribingDraft=(patient,draft)=>vm.runInContext('(p,d)=>{prescribingDrafts.set(p,d)}',sandbox)(patient,draft);
 sandbox.letIn=expression=>vm.runInContext(`(${expression})`,sandbox);
 sandbox.assignLet=(name,value)=>vm.runInContext(`${name}=globalThis.__seed`,sandbox,{}) ;
 for(const [key,value] of Object.entries(window))sandbox[key]=value;
 // The page's own service calls, recorded so a test can see which search a screen ran.
 sandbox.notice=(message,error)=>notices.push({message,error});
 sandbox.run=async fn=>{await fn();};
 const api=(path,method='GET',body,version)=>{calls.push({path,method,body,version});return Promise.resolve(sandbox.respond?sandbox.respond(path,method,body):{});};
 sandbox.api=api;


 for(const [key,value] of Object.entries(extra))sandbox[key]=value;
 // One script tag in a browser is a script running in the page's global scope, so every name it
 // declares at the top level lands there and the tag next to it can call it. vm.runInContext does
 // the opposite: it wraps the source in its own function scope and keeps those names private.
 // Running the file as a vm.Script reproduces the real thing, which is how the picker reaches a
 // screen's payer list and the screens reach the picker's helpers.
 const load=file=>{
  const path='web/'+file;
  new vm.Script(fs.readFileSync(path,'utf8'),{filename:path}).runInContext(sandbox);
 };
 load('typeahead.js');
 for(const file of files)load(file);
 // The handles the test needs, visible to the scripts by name and to the test as properties.
 Object.assign(sandbox,{dom,notices,calls,settle,queue});
 sandbox.window=sandbox;
 return sandbox;
}

const payers=()=>[
 {id:'payer-1',content:{name:'Example Health Plan',payer_code:'EX1',active:true}},
 {id:'payer-2',content:{name:'Example Mutual',payer_code:'EX2',active:true}},
 {id:'payer-3',content:{name:'Riverside Community Plan',payer_code:'RC9',active:false}},
];
// As the directory returns them: active is a top-level column, not part of the content.
const pharmacies=()=>[
 {id:'rx-1',active:true,content:{name:'Corner Pharmacy',address:'1 Example Street',phone:'555-0101'}},
 {id:'rx-2',active:true,content:{name:'Harbourside Pharmacy',address:'9 Dock Road',phone:'555-0102'}},
 {id:'rx-3',active:false,content:{name:'Old Town Apothecary',address:'4 Quay Lane',phone:'555-0103'}},
];
const rows=box=>box.list.children.filter(row=>row.dataset.typeaheadIndex!==undefined);
const namesOf=box=>rows(box).map(row=>row.children.find(child=>child.tag==='b')?.textContent||'');

// ---------------------------------------------------------------------------
// 1. The insurance company step of the coverage form.
// ---------------------------------------------------------------------------
// The chart's editor panes and form hosts, mounted where the screens expect to find them, and
// reachable through the screen's own $() lookup the way a browser finds them by id.
function mount(ctx,id,tag='section'){
 const node=ctx.dom.document.createElement(tag);
 node.id=id;node.attrs.id=id;node.parentElement=ctx.dom.body;node.parent=ctx.dom.body;
 ctx.dom.body.children.push(node);
 return node;
}
// The host a screen's own $() and querySelector look through: the node it renders into, with the
// document's search reaching the same tree. Screens draw a pane by replacing that host's contents,
// so the markup is set on the host and the document's body points at it — one tree, as in a page.
function pane(ctx,id,tag='div'){
 const host=mount(ctx,id,tag);
 ctx.dom.body.children=[host];
 return host;
}
function coverageScreen(rows=payers()){
 const ctx=workspace(['billing.js','claimmd-eligibility.js'],{
  me:{role:'owner'},selected:'synthetic-patient',chartSection:'insurance',busy:false,
  workspace:{billing:{coverages:[],accounts:[],entries:[]},visits:[],appointments:[],patient:{given_name:'Avery',family_name:'Synthetic',birth_date:'1980-01-01'}},
  dollars:cents=>cents?String(cents/100):'',sourceNotice:()=>'',
  selectField:(name,label,values,value)=>`<label>${label}<select name="${name}">${values.map(item=>`<option value="${item}">${item}</option>`).join('')}</select></label>`,
  billingField:(name,label,value='')=>`<label>${label}<input name="${name}" value="${esc(value)}"></label>`,
  showChartSection(){},chartOpenEditor(){},
  enableCoverageSubmit(){this.submitEnabled=true;},
 });
 // The chart's billing editor pane, which the coverage form is drawn into.
 ctx.editorHost=mount(ctx,'insurance-editor');
 // What the chart screen holds after loading the insurance records. `billingPayers` is a
 // top-level `let` in billing.js, so it lives in that file's script scope rather than on the
 // window; the test hands the records over the way the screen's own load step would.
 // `billingPayers` is a top-level `let` in billing.js, so it lives in that file's script scope
 // `billingPayers` is a top-level `let` in billing.js, so it lives in the script's own scope
 // rather than on the window. apply() hands it over so push mutates that array in place.
 // `billingPayers` is a top-level `let` in billing.js, so it lives in that file's own script
 // scope rather than on the window; apply() hands the rows to that array and mutates it in place.
 vm.runInContext('(pay)=>{billingPayers.length=0;billingPayers.push(...pay);}',ctx).call(undefined,rows);
 ctx.billingPayers=vm.runInContext('billingPayers',ctx);
 return ctx;
}
function scan(node,depth=0,out=[]){
 out.push('  '.repeat(depth)+(node.tag||'?')+' '+JSON.stringify(node.attrs||{}));
 for(const child of node.children||[])scan(child,depth+1,out);
 return out;
}
// The picker and the screens reach a box by id, exactly as they do through document.getElementById
// in a browser. Following the live tree rather than a flat id table keeps a replaced form from
// answering with the box it used to hold.
function boxOf(ctx,id){
 // The picker's popup is the name box's next sibling, so the box's own block is what holds
 // the results list, the status line and the hidden id.
 const input=byIdIn(ctx.dom.body,id);
 if(!input){console.log(scan(ctx.dom.body).join('\n'));throw new Error('no #'+id);}
 const host=input.parentElement;
 if(!host){console.log('BODY\n'+scan(ctx.dom.body).join('\n'));throw new Error('no parent for '+id);}
 return {input,host,idField:host.querySelector('[data-typeahead-id]'),list:host.querySelector('[data-typeahead-results]'),status:host.querySelector('[data-typeahead-status]')};
}

(async()=>{
 {
  const ctx=coverageScreen();
  ctx.coverageEditor(null,null);
  const box=boxOf(ctx,'coverage-payer-name');
  assert.ok(box.input,'the insurance company step is a typed box');
  assert.equal(box.input.tag,'input');
  assert.equal(box.input.getAttribute('role'),'combobox');
  assert.equal(box.input.getAttribute('aria-autocomplete'),'list');
  assert.equal(box.input.getAttribute('aria-expanded'),'false');
  assert.equal(box.input.getAttribute('autocomplete'),'off');
  assert.equal(box.input.getAttribute('spellcheck'),'false');
  assert.equal(box.input.getAttribute('aria-controls'),box.list.attrs.id);
  assert.equal(box.input.getAttribute('aria-describedby'),box.status.attrs.id);
  assert.equal(box.list.getAttribute('role'),'listbox');
  assert.equal(box.status.getAttribute('role'),'status');
  assert.equal(box.status.getAttribute('aria-live'),'polite');
  assert.equal(box.idField.attrs.name,'payer_id','the submitted value is the hidden id, not the visible name');
  assert.equal(box.idField.getAttribute('type'),'hidden');
  assert.ok(!ctx.dom.document.querySelector('#coverage-form select[name="payer_id"]'),'the old dropdown is gone');
  assert.ok(!/id="coverage-claimmd-payer-search"/.test(ctx.editorHost.innerHTML),'no Find or Search button form is left in the insurance step');

  box.input.dispatch({type:'focus'});
  assert.equal(rows(box).length,3,'focusing the box shows what is on file, with nothing to press');
  assert.deepEqual(namesOf(box),['Example Health Plan','Example Mutual','Riverside Community Plan']);
  assert.match(rows(box)[0].children.find(child=>child.tag==='small').textContent,/^EX1$/,'the small second line carries the insurer ID');
  assert.match(namesOf(box).join(' '),/Riverside/);
  assert.match(rows(box)[2].children.find(child=>child.tag==='small').textContent,/Not active/,'a plan no longer in use says so before staff pick it');
  assert.equal(box.input.getAttribute('aria-expanded'),'true');

  box.input.value='exam';box.input.dispatch({type:'input'});await ctx.settle();
  assert.deepEqual(namesOf(box),['Example Health Plan','Example Mutual']);
  assert.match(box.status.textContent,/2 matches\. Use/);

  box.input.value='  Riverside  ';box.input.dispatch({type:'input'});await ctx.settle();
  assert.deepEqual(namesOf(box),['Riverside Community Plan'],'stray spaces and letter case are ignored');

  box.input.value='plan';box.input.dispatch({type:'input'});await ctx.settle();
  assert.deepEqual(namesOf(box),['Example Health Plan','Riverside Community Plan'],'a word from the second line is not needed; a name match is');

  box.input.value='zzz';box.input.dispatch({type:'input'});await ctx.settle();
  assert.equal(rows(box).length,0);
  assert.match(box.status.textContent,/Nothing matches that yet/);
  assert.equal(box.input.value,'zzz','what staff typed is never thrown away');
  assert.equal(box.idField.value,'','an unchosen box submits nothing');

  box.input.value='exam';box.input.dispatch({type:'input'});await ctx.settle();
  assert.equal(box.input.dispatch({type:'keydown',key:'ArrowDown'}).defaultPrevented,true,'up and down belong to the picker');
  assert.equal(box.input.getAttribute('aria-activedescendant'),`${box.list.attrs.id}-option-0`);
  assert.equal(rows(box)[0].getAttribute('aria-selected'),'true');
  assert.equal(rows(box)[1].getAttribute('aria-selected'),'false');
  const enter=box.input.dispatch({type:'keydown',key:'Enter'});
  assert.equal(enter.defaultPrevented,true,'Enter never submits the form behind the list');
  assert.equal(box.input.value,'Example Health Plan');
  assert.equal(box.idField.value,'payer-1');
  assert.equal(rows(box).length,0,'the list closes once a choice is made');
  assert.equal(box.input.getAttribute('aria-expanded'),'false');

  const submitted=Object.fromEntries(new ctx.FormData(ctx.$('coverage-form')));
  assert.equal(submitted.payer_id,'payer-1','the form submits the id');
  assert.equal(submitted.payer_name,'Example Health Plan','and the name staff can read back');

  box.input.value='exam';box.input.dispatch({type:'input'});await ctx.settle();
  assert.equal(box.input.dispatch({type:'keydown',key:'Escape'}).defaultPrevented,true);
  assert.equal(rows(box).length,0);
  assert.equal(box.input.value,'exam','Escape keeps the typed text');
  assert.equal(box.idField.value,'');

  box.input.value='exam';box.input.dispatch({type:'input'});await ctx.settle();
  assert.equal(box.input.dispatch({type:'keydown',key:'Tab'}).defaultPrevented,false,'Tab still moves on');
  assert.equal(box.idField.value,'','Tab away from a partial name chooses nothing');

  box.input.value='exam';box.input.dispatch({type:'input'});await ctx.settle();
  box.input.dispatch({type:'keydown',key:'ArrowUp'});
  assert.equal(box.input.getAttribute('aria-activedescendant'),`${box.list.attrs.id}-option-1`,'ArrowUp with nothing highlighted starts at the last row');
  box.input.dispatch({type:'keydown',key:'ArrowDown'});
  assert.equal(box.input.getAttribute('aria-activedescendant'),`${box.list.attrs.id}-option-0`,'and ArrowDown from the last row wraps to the first');
  box.input.dispatch({type:'keydown',key:'ArrowUp'});
  assert.equal(box.input.getAttribute('aria-activedescendant'),`${box.list.attrs.id}-option-1`,'ArrowUp from the first row wraps to the last');

  box.input.value='Riverside Community Plan';box.input.dispatch({type:'input'});await ctx.settle();
  box.input.dispatch({type:'keydown',key:'Enter'});
  assert.equal(box.idField.value,'','Enter with nothing highlighted chooses nothing, so the wrong plan is never filed');
  box.input.dispatch({type:'keydown',key:'ArrowDown'});box.input.dispatch({type:'keydown',key:'Enter'});
  assert.equal(box.idField.value,'payer-3','one press down then Enter takes the only match');

  box.input.disabled=true;box.input.value='exam';box.input.dispatch({type:'input'});box.input.dispatch({type:'focus'});
  await ctx.settle();
  assert.equal(rows(box).length,0,'a box disabled while a save is in flight cannot open a list');
  box.input.disabled=false;

  box.input.value='Exam';box.input.dispatch({type:'input'});await ctx.settle();
  box.input.dispatch({type:'keydown',key:'Enter',isComposing:true});
  assert.equal(box.idField.value,'','Enter in the middle of an accented word is the keyboard’s, not a choice');

  // A choice made with the mouse, without submitting the form behind the list.
  const clicked=coverageScreen();
  clicked.coverageEditor(null,null);
  const clickBox=boxOf(clicked,'coverage-payer-name');
  clickBox.input.value='exam';clickBox.input.dispatch({type:'input'});await clicked.settle();
  const row=rows(clickBox)[1];
  assert.equal(row.getAttribute('aria-selected'),'false','a row is only highlighted once staff reach it');
  clicked.dom.document.dispatch({type:'pointerdown',target:row});
  clicked.dom.document.dispatch({type:'click',target:row});
  assert.equal(clickBox.idField.value,'payer-2');
  assert.equal(clickBox.input.value,'Example Mutual');
  assert.equal(rows(clickBox).length,0);

  // An exact name plus Tab picks it; an ambiguous name is never guessed at.
  const tabbed=coverageScreen();
  tabbed.coverageEditor(null,null);
  const tabBox=boxOf(tabbed,'coverage-payer-name');
  tabBox.input.value='Example Mutual';tabBox.input.dispatch({type:'blur'});
  assert.equal(tabBox.idField.value,'payer-2','an exact name and Tab chooses it');
  tabBox.input.value='Example';tabBox.input.dispatch({type:'input'});
  assert.equal(tabBox.idField.value,'','editing after a choice clears the id so a wrong insurer is never submitted');
  tabBox.input.dispatch({type:'blur'});
  assert.equal(tabBox.idField.value,'','a name that could mean two insurers is never guessed');

  // An existing coverage shows its insurer by name, never as a bare identifier.
  const editing=coverageScreen();
  editing.coverageEditor({id:'coverage-1',version:2,content:{payer_id:'payer-2',priority:'primary',status:'active',member_id:'SYN-MEMBER-1',group_number:'',plan_name:'',subscriber_name:'Avery Synthetic',subscriber_birth_date:'1980-01-01',relationship:'self',effective_date:'2023-01-01',end_date:'',verification:'unverified',notes:''}},null);
  const editBox=boxOf(editing,'coverage-payer-name');
  assert.equal(editBox.idField.value,'payer-2');
  assert.equal(editBox.input.value,'Example Mutual','a saved coverage shows the insurer by name');
  console.log('PASS insurance company box: matches as staff type, insurer ID on the second line, keyboard and mouse pick, name plus hidden id submitted, no Find or Search button');
 }

 // -----------------------------------------------------------------------
 // 2. The Claim.MD insurer lookup: the screen's own search, now as you type.
 // -----------------------------------------------------------------------
 {
  const ctx=coverageScreen();
  ctx.coverageEditor(null,null);
  // The Claim.MD lookup box and its results host are drawn by billing.js inside the coverage
  // editor, so the screen's own render supplies them.
   const query=ctx.$('coverage-claimmd-payer-query');

  assert.ok(query,'the Claim.MD directory lookup is still offered from the insurance step');
  const box=boxOf(ctx,'coverage-payer-name');
  let resolve;
  ctx.respond=()=>new Promise(yes=>{resolve=yes;});
  query.value='ex';query.dispatch({type:'input'});await ctx.settle();
  assert.equal(ctx.calls.length,0,'two letters return almost the whole directory, so nothing is searched yet');
  assert.equal(ctx.$('coverage-claimmd-payer-results').children.length,0);
  query.value='exam';query.dispatch({type:'input'});
  assert.equal(ctx.calls.length,0,'nothing is searched while the typing is still going');
  assert.equal(query.getAttribute('aria-busy'),'true','the box says a search is on its way');
  await ctx.settle();
  assert.equal(ctx.calls.length,1);
  assert.match(ctx.calls[0].path,/\/api\/v1\/billing\/claimmd\/payers\?name=exam$/,'the directory search this screen already had is what runs');
  resolve({items:[{payerid:'EX1',payer_name:'Example Health Plan'},{payerid:'EX9',payer_name:'Example Mutual'}]});
  await tick();
  assert.match(ctx.$('coverage-claimmd-payer-results').innerHTML,/Example Health Plan/);
  assert.match(ctx.$('coverage-claimmd-payer-results').innerHTML,/data-claimmd-payer-select="EX9"/,'each match can be chosen straight out of the list');
  assert.equal(query.getAttribute('aria-busy'),null);
  // Newer typing supersedes a slower answer.
  ctx.calls.length=0;
  let late;
  ctx.respond=()=>query.value==='examp'?new Promise(yes=>{late=yes;}):Promise.resolve({items:[]});
  query.value='examp';query.dispatch({type:'input'});await ctx.settle();
  query.value='riverside community plan';query.dispatch({type:'input'});await ctx.settle();
  late?.({items:[{payerid:'OLD',payer_name:'Old answer that arrived late'}]});
  await tick();
  assert.doesNotMatch(ctx.$('coverage-claimmd-payer-results').innerHTML,/arrived late/,'a late answer never replaces the newest one');
  // Choosing a match already on file fills the insurance company box.
  const cell=ctx.dom.document.createElement('td');cell.parent=ctx.editorHost;ctx.editorHost.children.push(cell);
  const button=ctx.dom.document.createElement('button');
  button.attrs['data-claimmd-payer-select']='EX2';button.attrs['data-payer-name']='Example Mutual';
  button.dataset.claimmdPayerSelect='EX2';button.dataset.payerName='Example Mutual';
  button.parentElement=cell;cell.children.push(button);
  ctx.dom.document.dispatch({type:'click',target:button});
  assert.equal(box.idField.value,'payer-2','an insurer already on file is chosen for this coverage');
  assert.equal(box.input.value,'Example Mutual');
  assert.ok(ctx.notices.some(note=>/Already on file/.test(note.message)));
  console.log('PASS the Claim.MD insurer lookup answers while staff type through the search the screen already used, and a match fills the insurance company box');
 }

 // -----------------------------------------------------------------------
 // 3. Prescribing: preferred pharmacy and intended pharmacy.
 // -----------------------------------------------------------------------
 {
  let directory;
  const ctx=workspace(['prescribing.js'],{
   me:{role:'clinician'},selected:'synthetic-patient',chartSection:'prescribing',activeVisit:{id:'visit-1'},
   workspace:{visits:[],appointments:[]},
   workspaceResourceAllowed:(resource,action)=>resource==='clinical'&&['create','edit'].includes(action),
   chartRecordTemplate:(id,html)=>{if(id==='rx-pharmacy')directory=html;return '';},
   rxCanDirectory:()=>true,rxCanPrepare:()=>true,rxCanAuthorize:()=>true,rxPharmacyLabel:()=> '',
  });
  ctx.panel=mount(ctx,'prescribing-panel');

  // prescribingStates is a screen-private const, so the rows are seeded into the map the file
  // made, the way the screen's own load step fills it.
  ctx.seedPrescribing('synthetic-patient',{pharmacies:pharmacies(),pharmacies_truncated:false,items:[],preference:{pharmacy_id:'rx-1',version:1},preference_pending:null,preference_draft:null,capabilities:{}});
  ctx.showPrescribing();
  assert.ok(ctx.panel.querySelector('[data-chart-detail="rx-pharmacy"]'),'the directory opens from Prescribing');
  const directorySheet=mount(ctx,'synthetic-pharmacy-sheet','div');
  directorySheet.innerHTML=directory;ctx.typeaheadInit(directorySheet);
  const preferred=boxOf(ctx,'pharmacy-name');
  assert.ok(preferred.input,'the preferred pharmacy step is a typed box');
  assert.equal(preferred.input.getAttribute('data-typeahead-pharmacy'),'optional','staff may clear it again to record no preferred pharmacy');
  assert.equal(preferred.input.required,false);
  assert.equal(preferred.input.value,'Corner Pharmacy','the saved preference shows its name');
  assert.equal(preferred.idField.value,'rx-1');
  preferred.input.dispatch({type:'focus'});
  assert.deepEqual(namesOf(preferred),['Corner Pharmacy','Harbourside Pharmacy','Old Town Apothecary'],'the saved preference shows its name');
  assert.match(rows(preferred)[2].children.find(child=>child.tag==='small').textContent,/1 Example Street|Not active/,'address on the small second line');
  preferred.input.value='harbour';preferred.input.dispatch({type:'input'});await ctx.settle();
  assert.deepEqual(namesOf(preferred),['Harbourside Pharmacy'],'typing narrows the list again');
  preferred.input.dispatch({type:'keydown',key:'ArrowDown'});
  preferred.input.dispatch({type:'keydown',key:'Enter'});
  assert.equal(preferred.idField.value,'rx-2');
  assert.equal(preferred.input.value,'Harbourside Pharmacy');
  // The preference form submits the id the picker filled in, not the name on screen.
  const preferenceForm=ctx.$('prescribing-preference-form');
  const values=Object.fromEntries(new ctx.FormData(preferenceForm));
  assert.equal(ctx.rxChosenPharmacyId(values),'rx-2','the preference form submits the chosen pharmacy id');
  // Clearing the box records no preferred pharmacy rather than a stale id.
  preferred.input.value='';preferred.input.dispatch({type:'input'});
  assert.equal(preferred.idField.value,'');
  console.log('PASS preferred pharmacy: type-as-you-go over the pharmacy directory, name shown, id submitted, and clearing it means no preference');
 }
 {
  const ctx=workspace(['prescribing.js'],{
   me:{role:'clinician'},selected:'synthetic-patient',chartSection:'prescribing',activeVisit:{id:'visit-1'},
   workspace:{visits:[],appointments:[]},rxCanDirectory:()=>true,rxCanPrepare:()=>true,rxCanAuthorize:()=>true,
  });
  ctx.panel=mount(ctx,'prescribing-panel');
  ctx.editor=mount(ctx,'prescribing-editor','div');
  ctx.seedPrescribing('synthetic-patient',{pharmacies:pharmacies(),pharmacies_truncated:false,items:[],preference:{pharmacy_id:null,version:1}});
  ctx.seedPrescribingDraft('synthetic-patient',{request_id:'synthetic-request',values:{content:{medication_name:'Synthetic medication',pharmacy_id:'rx-2'},visit_id:null,reason:''},pending:null,current:null});
  ctx.showPrescribingEditor();
  const intended=boxOf(ctx,'pharmacy-name');
  assert.ok(intended.input,'the intended pharmacy step is a typed box');
  assert.equal(intended.input.required,true,'a prescription must say where it is headed');
  assert.equal(intended.input.value,'Harbourside Pharmacy','the pharmacy on the draft shows by name');
  intended.input.dispatch({type:'focus'});
  assert.deepEqual(namesOf(intended),['Corner Pharmacy','Harbourside Pharmacy'],'inactive pharmacies are not offered for a new order');
  intended.input.value='corner';intended.input.dispatch({type:'input'});await ctx.settle();
  intended.input.dispatch({type:'keydown',key:'ArrowDown'});
  intended.input.dispatch({type:'keydown',key:'Enter'});
  assert.equal(intended.idField.value,'rx-1');
  const draftOf=()=>vm.runInContext('prescribingDrafts.get("synthetic-patient")',ctx);
  ctx.capturePrescribingDraft();
  assert.equal(draftOf().values.content.pharmacy_id,'rx-1','retained draft edits keep the chosen pharmacy');
  // A name typed by hand that matches nothing leaves the id empty, so the save is refused
  // rather than filing the order against the wrong pharmacy.
  intended.input.value='Somewhere Else';intended.input.dispatch({type:'input'});
  intended.input.dispatch({type:'blur'});
  assert.equal(intended.idField.value,'','an unknown pharmacy name submits no id');
  console.log('PASS intended pharmacy: type-as-you-go over active pharmacies, keyboard pick kept through draft capture, unknown names submit nothing');
 }

 // -----------------------------------------------------------------------
 // 4. Remittance import: one insurer box per payment in the file.
 // -----------------------------------------------------------------------
 {
  const ctx=workspace(['claims.js','era-batches.js'],{
   me:{role:'owner'},selected:'synthetic-patient',
   selectField:(name,label,values,value)=>`<label>${label}<select name="${name}"><option value="${value}">${value}</option></select></label>`,
   billingField:(name,label,value='')=>`<label>${label}<input name="${name}" value="${esc(value)}"></label>`,
   sourceNotice:()=>'',money:cents=>'$'+(cents/100).toFixed(2),human:value=>String(value||''),
   showClaimsWorkspace:async()=>{},showEraBatch:async()=>{},showEra:async()=>{},showProviderSettlement:async()=>{},
   notice(){},claimEditor(){},esc,
  });
  ctx.context={kind:'worklist'};
  ctx.host=mount(ctx,'claims-detail');
 // The file's own payer rows are what the batch picker offers; the screen holds them on its
 // preview after validating the file. (billingPayers belongs to the billing screen's scope and
 // is not loaded here, so the batch picker is driven entirely by the preview.)
  // The preview step offers one insurer box per transaction, pre-filled where the file's own
  // payer code matches exactly one record.
  const detail=mount(ctx,'era-batch-preview-detail','div');detail.parentElement=ctx.host;
 ctx.host.children=ctx.host.children.filter(node=>node!==detail);ctx.host.children.push(detail);
 const preview={payers:[{id:'nat-1',name:'Example Health Plan',payer_code:'EX1'},{id:'nat-2',name:'Example Mutual',payer_code:'EX2'}],parts:[{document:{payer_code:'EX1',trace:'T1',total_paid_cents:1000,claims:[{}]}},{document:{payer_code:'ZZ9',trace:'T2',total_paid_cents:2000,claims:[{}]}}],raw:'SYNTH',request_id:'synthetic-request'};
  vm.runInContext('(p)=>{eraBatchPreview=p}',ctx)(preview);
  detail.innerHTML=`<form id="era-batch-import">${preview.parts.map((part,index)=>ctx.batchPayerPickerMarkup(part,index,preview.payers)).join('')}${ctx.billingField('reason','Reason')}</form>`;
  ctx.typeaheadInit(detail);
  const first=boxOf(ctx,'era-batch-payer-0');
  assert.equal(first.input.value,'Example Health Plan','the file’s own payer code fills in the one insurer it can mean');
  assert.equal(first.idField.value,'');
  const second=boxOf(ctx,'era-batch-payer-1');
  assert.equal(second.input.value,'','a payer code the file cannot place is left for staff to name');
  first.input.dispatch({type:'focus'});
  assert.deepEqual(namesOf(first),['Example Health Plan','Example Mutual']);
  first.input.value='example mut';first.input.dispatch({type:'input'});await ctx.settle();
  first.input.dispatch({type:'keydown',key:'ArrowDown'});first.input.dispatch({type:'keydown',key:'Enter'});
  assert.equal(first.idField.value,'nat-2','typing over the suggested insurer re-chooses it');
  // What the import submits.
  second.input.value='Example Health Plan';second.input.dispatch({type:'input'});
  second.input.dispatch({type:'blur'});
  const values=Object.fromEntries(new ctx.FormData(detail.children[0]));
  assert.equal(ctx.batchChosenPayerId(detail.children[0],preview,0,values),'nat-2','the chosen insurer id is what the file is staged with');
  assert.equal(ctx.batchChosenPayerId(detail.children[0],preview,1,values),'nat-1','and an exact name typed and tabbed away resolves too');
  console.log('PASS 835 import: one insurer box per payment, filled from the file where it is unambiguous, resolved to the record id on save');
 }

 // -----------------------------------------------------------------------
 // 5. Secondary insurance on a claim, and the wiring that keeps it honest.
 // -----------------------------------------------------------------------
 {
  const ctx=workspace(['billing.js','claims.js'],{
   me:{role:'owner'},claimEditor(){},
   claimContextSnapshot:()=>ctx.context,
   claimIssues:()=>'',crossoverReviewMarkup:()=>'',claimChargeDiagnosisDefaults:()=>({}),
   money:cents=>'$'+(cents/100).toFixed(2),human:value=>String(value||''),esc,
   claimPane(){},
  });
  ctx.context={kind:'worklist'};
 vm.runInContext('(rows)=>{billingPayers.length=0;billingPayers.push(...rows)}',ctx)(payers());
  const choices=[
   // As the secondary step receives them: each plan joined to the insurer it belongs to.
   {coverage:{id:'cov-2',version:3,content:{priority:'secondary',member_id:'SYN-M-2'}},payer:{id:'payer-2',content:{name:'Example Mutual'}}},
   {coverage:{id:'cov-3',version:1,content:{priority:'tertiary',member_id:'SYN-M-3'}},payer:{id:'payer-3',content:{name:'Riverside Community Plan'}}},
  ];
  // The claims pane the secondary step is drawn into, and the markup the real render produces:
  // coveragePickerMarkup is where that step hands its plans to the screen, and calling it is what
  // records them, exactly as the render does.
  const host=pane(ctx,'claims-detail');
  host.innerHTML=`<section><form id="secondary-claim-review">${ctx.coveragePickerMarkup(choices)}<button type="submit">Continue</button></form></section>`;
  ctx.typeaheadInit(host);
  const box=boxOf(ctx,'secondary-coverage-name');
  assert.ok(box.input,'the secondary insurance step is a typed box');
  box.input.dispatch({type:'focus'});
  assert.deepEqual(namesOf(box),['Example Mutual','Riverside Community Plan'],'only the plans that can still be billed are offered');
  assert.match(rows(box)[0].children.find(child=>child.tag==='small').textContent,/secondary · Member SYN-M-2/i,'the small line says which plan it is');
  box.input.value='example mut';box.input.dispatch({type:'input'});await ctx.settle();
  box.input.dispatch({type:'keydown',key:'ArrowDown'});box.input.dispatch({type:'keydown',key:'Enter'});
  assert.equal(box.idField.value,'cov-2','the plan id the claim is built from is submitted');
  // A page finds the form it is about to submit by id, which is how the screen reaches it too.
  const form=ctx.$('secondary-claim-review');
  assert.ok(form,'the secondary step is a form the screen can submit');
  const values=Object.fromEntries(new ctx.FormData(form));
  assert.equal(values.coverage_id,'cov-2','the form carries the plan id the picker filled in');
  assert.equal(ctx.secondaryChosenCoverageId(form,values),'cov-2');
  // Typed by hand and tabbed away resolves the same way; a partial name is never guessed at.
  const partial=Object.assign({},values,{coverage_id:'',coverage_name:'example'});
  assert.equal(ctx.secondaryChosenCoverageId(form,partial),'','an ambiguous secondary plan is never guessed');
  const typed=Object.assign({},values,{coverage_id:'',coverage_name:'Riverside Community Plan'});
  assert.equal(ctx.secondaryChosenCoverageId(form,typed),'cov-3');
  console.log('PASS secondary insurance: type-as-you-go over the plans still available, plan id submitted, ambiguous names refused');
 }

 // -----------------------------------------------------------------------
 // 6. Wiring: one binding per box, and the pages that must never gain a search button.
 // -----------------------------------------------------------------------
 {
  const ctx=coverageScreen();
  ctx.coverageEditor(null,null);
  const first=boxOf(ctx,'coverage-payer-name');
  first.input.value='exam';first.input.dispatch({type:'input'});await ctx.settle();
  const before=rows(first).length;
  // The same screen re-rendered must not stack a second binding on the box.
  ctx.coverageEditor(null,null);
  const again=boxOf(ctx,'coverage-payer-name');
  again.input.value='exam';again.input.dispatch({type:'input'});await ctx.settle();
  assert.equal(rows(again).length,before,'redrawing the form leaves exactly one picker on the box');
  again.input.dispatch({type:'keydown',key:'ArrowDown'});again.input.dispatch({type:'keydown',key:'Enter'});
  assert.equal(again.idField.value,'payer-1','and the choice is made once, not twice');

  const source=index=>fs.readFileSync(index,'utf8');
  const page=source('web/index.html');
  const scripts=[...page.matchAll(/<script src="\/([a-z-]+\.js)" defer><\/script>/g)].map(match=>match[1]);
  assert.ok(scripts.includes('typeahead.js'),'the workspace loads the picker');
  for(const screen of ['billing.js','claims.js','era-batches.js','prescribing.js'])
   assert.ok(scripts.indexOf('typeahead.js')<scripts.indexOf(screen),`${screen} loads after the picker so its boxes can be wired`);
 assert.ok(scripts.includes('autorefresh.js')&&scripts.indexOf('autorefresh.js')<scripts.indexOf('typeahead.js'),'the auto-refresh core loads before the picker it wraps');
  assert.ok(page.includes('/typeahead.css'),'and the picker ships with its own stylesheet');
  const rust=source('src/lib.rs');
  assert.match(rust,/include_str!\("\.\.\/web\/typeahead\.js"\)/,'the picker is served by the app, not left out to 404');
  assert.match(rust,/include_str!\("\.\.\/web\/typeahead\.css"\)/,'and so is its stylesheet');

  // The payer and pharmacy steps must not fall back to a Find/Search button anywhere.
  const screens=['web/billing.js','web/claims.js','web/era-batches.js','web/prescribing.js','web/typeahead.js'];
  for(const file of screens){
   const text=source(file);
   assert.doesNotMatch(text,/>Search<\/button>|>Find payer<\/button>|>Find pharmacy<\/button>/,`${file} leaves no search button for staff to press`);
  }
  // The box is announced as a combobox whose list fills in as the person types, and every row is
  // an option the screen reader can land on. The picker sets these on a box it is given — through
  // markup of its own or a plain input a screen drew — so it is checked on a live box.
  const announced=boxOf(ctx,'coverage-payer-name');
  announced.input.dispatch({type:'focus'});
  assert.equal(announced.input.getAttribute('role'),'combobox','the box announces itself as a combobox');
  assert.equal(announced.input.getAttribute('aria-autocomplete'),'list','and says matches appear as the person types');
  assert.equal(announced.input.getAttribute('aria-expanded'),'true','while the list is open in front of staff');
  assert.equal(announced.list.getAttribute('role'),'listbox','the matches are a list of choices');
  assert.ok(rows(announced).every(row=>row.getAttribute('role')==='option'),'and every match is a choice that can be picked');
  assert.ok(announced.input.getAttribute('aria-controls'),'the box points at the list it controls');
  console.log('PASS wiring: the picker loads first, is served by the app, survives a screen redraw, and no payer or pharmacy step keeps a search button');
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
// The redraw sweep walks a list it can iterate: a WeakMap cannot be walked, and doing so threw on
// every screen change and stopped newly drawn pickers from being wired.
{
 const src=require('node:fs').readFileSync(require('node:path').join(__dirname,'..','web','typeahead.js'),'utf8');
 require('node:assert/strict').ok(!/of \[\.\.\.typeaheadHosts\]/.test(src),'the sweep never iterates the WeakMap');
 require('node:assert/strict').ok(/typeaheadLive=new Set\(\)/.test(src),'live pickers are kept in an iterable set');
 console.log('PASS sweep: walks the live picker set, never the WeakMap');
}
