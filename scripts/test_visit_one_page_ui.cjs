// SPDX-License-Identifier: AGPL-3.0-only
// The visit is one scrolling page: heading + actions, vitals, note, codes & charges, finish. These
// checks run the real encounterWorkflow / setEncounterSection / applyChartSection /
// patientSectionVisible / renderVisit code from web/app.js, the real chart-host placement from
// web/app.js, and the real renderEncounterRevenue (web/patient-revenue.js) with the real charge
// section markup (web/billing.js) against a small DOM stub, and prove: no numbered step bar
// remains, the old step keys still open the page and land on the block they name, the page stays
// one page when billing or checkout is hidden, the Orders and Files areas take the whole screen
// until Back to visit, the block hosts keep their visual order after the first render, after a
// revenue re-render and after switching visits, recorded vitals collapse to one summary line with
// an Edit vitals button, and exactly one #visit-diagnoses sits at the top of codes & charges —
// draft or posted visit, open or closed charge table — while a person without billing keeps the
// note's own editor. Synthetic data only. No browser, no network.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/app.js','utf8'),specialty=fs.readFileSync('web/specialty-workspace.js','utf8');
const billing=fs.readFileSync('web/billing.js','utf8'),revenue=fs.readFileSync('web/patient-revenue.js','utf8');

function runStage(context,source,name){try{vm.runInContext(source,context,{filename:name});}catch(error){error.message=name+': '+error.message+' :: '+(error.stack||'').split('\n').slice(0,3).join(' || ');throw error;}}
// ---- the small DOM: enough of the tree for real placement code to run --------------------
const VOID_TAGS=new Set(['input','br','img','meta','link','hr','source']);
function parseMarkup(html,nodes){
 const roots=[];const stack=[];const re=/(<!--[\s\S]*?-->)|<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;let match,last=0;
 // void elements, per the parser; anything else that closes before opening is markup the
 // template wrote (a stray </div> where a <div> was already closed), which the browser drops.
 const VOID=new Set([...VOID_TAGS,'col','embed','track','wbr','area','base','param']);
 const push=node=>{
  let depth=stack.length;
  while(depth>0&&['p','option','li'].includes(stack[depth-1].tag))depth--;
  const parent=depth?stack[depth-1]:null;
  if(parent){parent.children.push(node);node.parent=parent;}else roots.push(node);
 };
 const textBetween=gap=>{
  const text=unescapeText(gap);
  if(!text.trim())return;
  const parent=stack.length?stack[stack.length-1]:null;
  if(parent)parent._text+=text;else roots.push(Object.assign(makeNode('#text',nodes),{_text:text}));
 };
 while((match=re.exec(html))){
  textBetween(html.slice(last,match.index));last=re.lastIndex;
  const[whole,comment,tagRaw,attrText,selfClose]=match,tag=tagRaw?tagRaw.toLowerCase():null;
  if(comment)continue; // a comment carries nothing the checks look at
  if(whole.startsWith('</')){
   for(let i=stack.length-1;i>=0;i--)if(stack[i].tag===tag){stack.length=i;break;}
   continue;
  }
  const node=makeNode(tag,nodes);
  for(const part of (attrText.trim()==='/'?[]:attrText.match(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)||[])){
   const m=/^([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?$/.exec(part.trim());if(!m)continue;
   const name=m[1].toLowerCase(),value=m[2]!==undefined?unescapeText(m[2]):m[3]!==undefined?unescapeText(m[3]):true;
   node.attrs[name]=value;
   if(name.startsWith('data-'))node.dataset[name.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(value);
   if(name==='id')node.id=value;
   if(name==='class')node.className=String(value);
   if(name==='value')node.value=String(value);
   if(name==='hidden')node.hidden=true;
  }
  push(node);
  if(!selfClose&&!VOID.has(tag)&&!['p','option','li'].includes(tag))stack.push(node);
 }
 textBetween(html.slice(last));
 return roots;
}
function makeNode(tag,nodes){
 // children and dataset must exist before any accessor runs on the node. The node remembers its
 // fixture's id table, so ids, scroll notices and traversal keep working as nodes move.
 const node={tag:tag||'div',id:'',className:'',attrs:Object.create(null),dataset:Object.create(null),_children:[],parent:null,hidden:false,_text:'',value:'',_nodes:nodes};
 Object.defineProperty(node,'innerHTML',{
  get(){return node.children.map(child=>serialize(child)).join('');},
  set(html){dropRegistered(node);node.children=[];node._text='';for(const child of parseMarkup(String(html),nodes)){insert(node,child);claimTree(child);}}});
 Object.defineProperty(node,'outerHTML',{get(){return serialize(node);}});
 Object.defineProperty(node,'textContent',{get(){return node.children.map(child=>child.textContent).join('');},set(text){dropRegistered(node);node.children=[];node._text=String(text);}});
 Object.defineProperty(node,'firstElementChild',{get(){return node.children[0]??null;}});
 node.firstChild=undefined;
 Object.defineProperty(node,'firstChild',{get(){return node.children[0]??null;}});
 Object.defineProperty(node,'lastElementChild',{get(){return node.children.at(-1)??null;}});
 Object.defineProperty(node,'children',{get(){return node._children||(node._children=[]);},set(list){node._children=list;}});
 Object.defineProperty(node,'parentElement',{get(){return node.parent;}});
 node.isConnected=true;
 node.setAttribute=(name,value)=>{node.attrs[String(name).toLowerCase()]=String(value);};
 node.getAttribute=name=>node.attrs[String(name).toLowerCase()]??null;
 node.classList={toggle(){},contains:()=>false};
 node.appendChild=child=>{child.parent?.children.splice(child.parent.children.indexOf(child),1);insert(node,child);return child;};
 node.append=(...parts)=>{for(const part of parts)if(typeof part==='string')node._text+=part;else node.appendChild(part);};
 node.removeChild=child=>{const at=node.children.indexOf(child);if(at<0)return child;node.children.splice(at,1);child.parent=null;release(child);return child;};
 node.insertBefore=(child,reference)=>{
  child.parent?.children.splice(child.parent.children.indexOf(child),1);
   const index=reference?node.children.indexOf(reference):-1;
  if(index>=0)node.children.splice(index,0,child);else node.children.push(child);
  child.parent=node;register(child,node);return child;};
 node.replaceChildren=(...parts)=>{node.children.forEach(child=>release(child));node.children=[];node._text='';node.append(...parts);};
 node.remove=()=>{if(!node.parent)return;const at=node.parent.children.indexOf(node);if(at>=0)node.parent.children.splice(at,1);release(node);node.parent=null;};
 node.replaceWith=other=>{const parent=node.parent;if(!parent)return;other.parent?.children.splice(other.parent.children.indexOf(other),1);parent.children[parent.children.indexOf(node)]=other;other.parent=parent;release(node);node.parent=null;node.isConnected=false;register(other,parent);};
 node.contains=other=>{let at=other;while(at){if(at===node)return true;at=at.parent;}return false;};
 node.closest=selector=>{let at=node;while(at){if(matches(at,selector))return at;at=at.parent;}return null;};
 node.querySelector=selector=>node.querySelectorAll(selector)[0]||null;
 node.querySelectorAll=selector=>{const out=[];collect(node,selector,out);return out;};
 node.focus=()=>{};
 node.scrollIntoView=()=>{const store=node._nodes;if(store&&store.onScroll)store.onScroll(node.id);};
 node.content=tag==='template'?{querySelector:selector=>node.querySelector(selector),querySelectorAll:selector=>node.querySelectorAll(selector)}:undefined;
 return node;
}
function insert(parent,child){child.parent=parent;parent.children.push(child);register(child,parent);claimTree(child);}
// An id answers for the node actually connected to the page: a node parsed with that id into the
// markup claims the slot, and a stale entry stops answering as soon as it is disconnected.
function claimTree(node){
 const store=node._nodes||storeOf(node);
 if(!store)return;
 if(node.id&&(!store[node.id]||!store[node.id].isConnected||store[node.id]===node))store[node.id]=node;
 for(const child of node.children)claimTree(child);
}
// A subtree remembers the id table of the tree it lives in, so ids stay findable as nodes move.
function storeOf(node){let at=node;while(at){if(at._nodes)return at._nodes;at=at.parent;}return null;}
function adopt(node,store){if(!store)return;node._nodes=store;if(node.id)store[node.id]=node;for(const child of node.children)adopt(child,store);}
function register(node,parent){
 const store=parent?parent._nodes||storeOf(parent):null;
 adopt(node,store);
}
function release(node){
 const store=node._nodes;
 if(node.id&&store&&store[node.id]===node)delete store[node.id];
 node.isConnected=false;
 for(const child of node.children)release(child);
}
function dropRegistered(node){for(const child of node.children)release(child);}
function collect(node,selector,out){for(const child of node.children){if(matches(child,selector))out.push(child);collect(child,selector,out);}}
function matches(node,selector){
 return String(selector).split(',').some(one=>{
  one=one.trim();
  const classes=one.match(/\.[\w-]+/g)||[],ids=one.match(/#[\w-]+/g)||[];
  let rest=one.replace(/\.[\w-]+/g,'').replace(/#[\w-]+/g,'');
  rest=rest.replace(/\[[^\]]+\]/g,'');
  if(rest&&rest!=='*'&&node.tag!==rest.toLowerCase())return false;
  if(!ids.every(id=>node.id===id.slice(1)))return false;
  const classNames=String(node.className||'').split(/\s+/);
  return classes.every(name=>classNames.includes(name.slice(1)));});
}
function serialize(node){
 if(node.tag==='#text')return escapeText(node._text||'');
 const attrs=Object.entries(node.attrs).filter(([,v])=>v!==false).map(([name,v])=>v===true?` ${name}`:` ${name}="${escapeAttribute(v)}"`).join('');
 if(node.tag==='input')return `<input${attrs}>`;
 return `<${node.tag}${attrs}>${escapeText(node._text||'')}${node.children.map(child=>serialize(child)).join('')}</${node.tag}>`;
}
// Round-tripping markup through innerHTML must reproduce the same tree, so text and attribute
// values go back out escaped exactly as the browser (and the parser below) expects them.
function escapeAttribute(value){return String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');}
function escapeText(value){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}
function unescapeText(value){return String(value).replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');}
// An id lookup finds the live host carrying that id; a detached entry in the table counts for
// nothing, so a host parsed out of markup becomes the page's one, and a host dropped by a
// re-render stops answering until its replacement arrives — close to a browser.
function liveById(id,nodes){
 const recorded=nodes[id];
 if(recorded?.isConnected)return recorded;
 let found=null;
 const walk=node=>{for(const child of node.children){if(!found&&child.id===id)found=child;walk(child);}};
 for(const root of Object.values(nodes))if(!found&&root.isConnected)walk(root);
 if(found)nodes[id]=found;
 return found;
}
function hostFor(id,nodes){
 // A host the fixture wants before the markup carries it: created detached, and only answering
 // getElementById once something connects it to the page.
 const created=makeNode(id==='encounter-revenue'?'section':'div',nodes);
 created.id=id;nodes[id]=created;return created;
}function createDocument(nodes){
 return {
  createElement:tag=>{const node=makeNode(String(tag).toLowerCase(),nodes);return node;},
  getElementById:id=>liveById(id,nodes),
  addEventListener(){},querySelectorAll:selector=>{const out=[];for(const root of Object.values(nodes))if(root.isConnected)collect(root,selector,out);return out;},
  querySelector:selector=>{for(const root of Object.values(nodes))if(root.isConnected){const hit=root.querySelector?.(selector);if(hit)return hit;}return null;},
 };
}
// A node list in document order (pre-order) for a chosen set of ids.
function orderOf(root,ids){
 const found=[];
 const walk=node=>{for(const child of node.children){if(ids.includes(child.id)&&!found.includes(child.id))found.push(child.id);walk(child);}};
 walk(root);
 return found;
}

// renderChart's chart markup: the real template literal from web/app.js with the renderers that
// need a back end stubbed to empty strings. The visit hosts themselves come from
// ensureVisitPageHost, so the page order under test is the shipped one.
function chartMarkup(){
 const start=app.indexOf('function renderChart() {');
 const begin=app.indexOf("$('chart').innerHTML=`",start);
 assert.ok(start>=0&&begin>start,'renderChart still sets #chart.innerHTML from a template');
 const end=app.indexOf('`;',begin);
 assert.ok(end>begin,'the #chart markup template closes');
 const body=app.slice(begin+"$('chart').innerHTML=`".length,end)
  .replaceAll('${chartOverview()}','')
  .replaceAll('${encounterWorkflow()}','')
  .replaceAll('${patientAppointmentWorkspace()}','');
 // The template literal runs inside the vm, where the fixture's stubs stand in for everything the
 // markup interpolates. The page's own heading belongs to #encounter-progress, which the fixture
 // renders on its own; inside the raw markup it is simply dropped.
 return body.replaceAll('${encounterWorkflow()}','');
}

// ---- the vm page ---------------------------------------------------------------------------
function fixture({billing:billingVisible=true,checkout=true,role='owner',account=null,vitals=null,visitId='visit-1'}={}){
 const scrolls=[],notices=[],nodes=Object.create(null);
 const documentStub=createDocument(nodes);
 // Every node made through this fixture remembers the table, so a scroll can be reported by id.
 nodes.onScroll=id=>scrolls.push(id);
 // The fixture's own handle on a host id: the live node when the page carries one, otherwise a
 // detached stand-in recorded in the same table, which becomes the page's host if markup is
 // connected through it.
 const node=id=>liveById(id,nodes)||hostFor(id,nodes);
 const renderLog=[];
 const context=vm.createContext({console,Map,Set,Array,Object,Number,Date,structuredClone,RegExp,JSON,String,Boolean,Math,Error,Promise,Symbol,
  document:documentStub,createElement:tag=>documentStub.createElement(tag),getElementById:id=>documentStub.getElementById(id),
  $:id=>documentStub.getElementById(id),
  selected:'patient-1',visitDrafts:new Map(),insuranceAppointmentSelection:new Map(),
  esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),date:value=>value,encounterDateLabel:()=>'Synthetic visit',
  notice:(...args)=>notices.push(args),captureVisitDrafts(){},capturePrescribingDraft(){},updateDraftStatus(){},followUnchangedNote(){},canDocument:()=>true,
  captureVisitAmendmentDraft(){},currentAmendmentDraft:()=>null,updateVisitAmendmentStatus(){},
  visitNoteAuthorshipLine:()=>'',visitNoteSignedLine:()=>'Signed',visitNoteAmendmentAuthor:()=>'',visitNoteSaved(){},renderVisitNoteSource(){},renderEncounterStartBenefits(){},
  isRoomingStaff:()=>false,canRecordVisitVitals:()=>true,canDraftNote:()=>true,canSignNote:()=>true,canAmendNote:()=>false,
  workspaceResourceAllowed:resource=>resource!=='billing'||billingVisible,
  postSignReminderMarkup:()=>'',refreshPatientChartContext(){},applyLabEncounterScope(){},documentFileNavigationChanged(){},refreshEncounterProgress(){},
  renderEncounterRevenue(){globalThis.renderEncounterRevenue();},renderEncounterFiles(){renderLog.push('renderEncounterFiles');},renderRooming(){},disabledRender(){renderLog.push('disabledRender');},

  renderVisitCheckout(){renderLog.push('renderVisitCheckout');},renderPatientBillingChart(){renderLog.push('renderPatientBillingChart');},renderPrescribing(){},openPatientChartTab(){},startEncounterFlow(){},selectEncounter(){},closeEncounterFlow(){},
  revenueServiceDate:()=>null,rememberVisit(){},editLabOrder(){},openEncounterCharges(){},patientBannerChanged(){},
  noteSourceText:()=>'',noteSourceLine:()=>'' ,noteProcedureHint:'What was done',visitAmendmentContexts:new WeakMap(),
  noteSectionKeys:['subjective','objective','assessment','plan','procedure','started_from'],
  api:async()=>({version:1})});
 context.renderLog=renderLog;context.mark=name=>renderLog.push(name);
  // The real editor (web/visit-diagnoses.js) keeps its form as a node across renders and draws it
  // into #visit-diagnoses only while no form is there yet. This stands in for it the same way: the
  // form is made and appended as nodes, never handed to innerHTML as a string, because a fixture
  // that re-parsed its own editor could not tell a preserved node from a rebuilt one.
  runStage(context,'var visitDiagnosisDrafts=new Map();function renderVisitDiagnoses(){renderLog.push("renderVisitDiagnoses");const host=$("visit-diagnoses");if(host&&!host.querySelector("#visit-diagnoses-form")){const form=document.createElement("form");form.id="visit-diagnoses-form";const row=document.createElement("div");row.dataset.diagnosisRow="";const input=document.createElement("input");input.name="code";input.value="";row.appendChild(input);form.appendChild(row);host.appendChild(form);}}','visit-diagnoses-drawer.js');
 context.getRenders=()=>({revenue:renderLog.filter(name=>name==='renderEncounterRevenue').length,files:renderLog.filter(name=>name==='renderEncounterFiles').length,diagnoses:renderLog.filter(name=>name==='renderVisitDiagnoses').length});
 context.nodes=nodes;context.documentStub=documentStub;
 context.orderOf=function(a,b){return orderOf(a&&Array.isArray(a)?nodes.chart:a,b&&Array.isArray(b)?b:a);};
 context.accountSeed=account;context.vitalsSeed=vitals;context.visitId=visitId;context.node=node;
 context.CHART_MARKUP=chartMarkup();
 // The hosts of the shipped page, handed over before any renderer runs the way renderChart's
 // innerHTML would put them on the page: the ids the chart markup carries, plus the fixed-order
 // visit row and the record-area panels applyChartSection and the file renderers reach for.
 for(const id of (context.CHART_MARKUP.match(/id="([\w-]+)"/g)||[]).map(tag=>tag.slice(4,-1)))node(id);
 for(const id of ['visit-editor','encounter-revenue','visit-checkout','encounter-orders-actions','documents-panel','lab-workspace','billing-workspace','insurance-workspace','prescribing-panel','clinical-lists','chart-overview','patient-next-action','patient-identity-panel','patient-demographics','referrals-panel'])node(id);
 runStage(context,'function hostFor(id){return globalThis.hostFor(id);}','vm-helpers.js');
 runStage(context,specialty,'specialty-workspace.js');
 // The app-level state lives on the vm's global object — never as a lexical `let` inside the vm,
 // which would shadow it for every later script — so tests can restate it freely.
 runStage(context,"var chartSection='visits',encounterSection='visit',workspace=null,activeVisit=null;",'vm-globals.js');
 const extract=(startText,endText)=>{const start=app.indexOf(startText),end=app.indexOf(endText,start);assert.ok(start>=0&&end>start,'anchor moved: '+startText);return app.slice(start,end);};
 // On the shipped page every module is one script, so a bare renderEncounterRevenue() lands on
 // the real block. Here each slice loads as its own script, and a script's top-level function
 // declaration hides the context property of the same name from the *next* script's bare call.
 // The real block is therefore installed as the context property under its own name, and any
 // slice loaded after it gets its call sites routed through globalThis — never the block itself.
 const throughGlobal=source=>String(source).replaceAll('renderEncounterRevenue();','globalThis.renderEncounterRevenue();');
  // The same rule the other way: slices loaded *before* the real block keep the app's own
  // `typeof ... === 'function'` guard, because no script-scope declaration shadows it yet.
 // Real navigation code: heading + action row + step keys + one-page visibility rules.
 runStage(context,extract('function encounterWorkflow(){','function encounterSections(){'),'encounter-navigation.js');
 runStage(context,extract('function encounterSections(){','function renderEncounterOrderActions(){'),'encounter-sections.js');
 runStage(context,throughGlobal(extract('function setEncounterSection(key){','function chartAreaEnabled(key){')),'encounter-steps.js');
 runStage(context,extract('function renderEncounterOrderActions(){','function setEncounterSection('),'encounter-orders-actions.js');
 runStage(context,extract('function chartAreaEnabled(key){','function chartNavigation(tabs)'),'chart-navigation.js');
 runStage(context,extract('function showChartSection(key){','function closeNavigation()'),'chart-show.js');
 // Real chart-host placement and the real vitals markup helpers, in front of the renderer.
 // Only the host placement belongs to the page: the extraction stops at the end of
 // ensureVisitPageHost so no app-level let/const in web/app.js leaks into the vm as a lexical
 // binding, which would shadow the fixture's globals for every later script.
 runStage(context,extract('const VISIT_PAGE_HOST_ID=','let patientWorkspaceGeneration='),'encounter-page.js');
 runStage(context,extract('const VISIT_VITAL_LABELS=','function canRecordVisitVitals('),'encounter-vitals.js');
 const renderVisitStage=extract('function renderVisit(activate=true) {','function renderHistory()')
  .replaceAll('renderEncounterStartBenefits(','disabledRender(');
 assert.ok(renderVisitStage.includes('disabledRender('),'renderVisit still calls renderEncounterStartBenefits by name');
 runStage(context,throughGlobal(renderVisitStage),'encounter-render.js');
 // Real billing section markup and the real revenue block, so the diagnoses host is the one the
 // page actually builds.
 runStage(context,`var billingCan=()=>${billingVisible};`,'billingcan.js');
 runStage(context,billing.slice(billing.indexOf('function encounterDiagnosesHostExists()'),billing.indexOf('// The amount an edit leaves behind')),'billing-diagnoses-section.js');
  // Real declarations taken at their exact position in web/patient-revenue.js. The eligibility
  // helpers in between are not under test here and stay out.
 const at=(needle)=>{const i=revenue.indexOf(needle);assert.ok(i>=0,'anchor moved: '+needle);return i;};
 runStage(context,revenue.slice(at('let insuranceEligibilityState='),at('function eligibilityState(){')),'encounter-revenue-states.js');
 // In the shipped page the real editor in web/visit-diagnoses.js draws itself when asked; here
 // the request is met by drawing one row into an empty host, keeping the ids the checks read.
 runStage(context,revenue.slice(at('function visitBillingStateContext('),at('function encounterChargesFilledIn(){')),'encounter-revenue-context.js');
 runStage(context,`
  function encounterChargeAccount(){return (workspace.billing?.accounts||[]).find(a=>a.status!=='void'&&a.content.visit_id===activeVisit?.id)||null;}
  function encounterRevenueStatusMarkup(){return '<div class="revenue-card-stub"></div>';}
  function encounterOnBillingStep(){return encounterShows('charges');}
  function encounterChargesFilledIn(){return false;}
  function visitReviewClose(){}
  function hostedCopayPanel(){return '';}
  function revenueCoverage(){return null;}
  function visitBillingDate(value){return String(value||'');}
  function showBillingAccount(){}
  function loadEncounterRevenueStatus(){}
  function loadHostedCopays(){}
  function resumeEncounterChargeDraft(){}
  function captureBillingChargeDraft(){}
  function chargeProposalTouched(){}
  function openEncounterCharges(){globalThis.renderEncounterRevenue();}
 `,'encounter-revenue-stubs.js');
 const helpersStart=revenue.indexOf('// The diagnoses editor');
 const helpersEnd=revenue.indexOf('function copayUnapplied(',helpersStart);
 assert.ok(helpersStart>=0&&helpersEnd>helpersStart,'the diagnoses host helpers sit at the top of web/patient-revenue.js');
 runStage(context,revenue.slice(helpersStart,helpersEnd),'encounter-diagnoses-helpers.js');
  // The app calls renderEncounterRevenue bare, as the shipped page does from renderVisit and the
  // click handlers. A function declared at a script's top level outranks the context property of
  // the same name for later scripts' bare calls, so the real block is installed as the context
  // property through this counting wrapper; later slices route their call sites through globalThis.
 runStage(context,"function renderEncounterRevenue(){globalThis.mark('renderEncounterRevenue');globalThis.renderEncounterRevenueActual();}globalThis.__counter=renderEncounterRevenue;",'revenue-counter.js');
 const blockStart=revenue.indexOf('function renderEncounterRevenue(){');
 const blockEnd=revenue.indexOf('\n}',revenue.indexOf('resumeEncounterChargeDraft();',blockStart));
 assert.ok(blockStart>=0&&blockEnd>blockStart,'renderEncounterRevenue can be taken whole from web/patient-revenue.js');
 runStage(context,revenue.slice(blockStart,blockEnd+2),'encounter-revenue.js');
 runStage(context,'globalThis.renderEncounterRevenueActual=renderEncounterRevenue;globalThis.renderEncounterRevenue=globalThis.__counter;','revenue-install.js');
 context.hostFor=id=>hostFor(id,nodes);
 const adoptParsedHosts=()=>{
  const editor=liveById('visit-editor',nodes);
  for(const id of ['encounter-intake','encounter-documentation']){
   const parsed=editor?.querySelector?.('#'+id);
   if(!parsed||nodes[id]===parsed)continue;
   nodes[id]=parsed;
  }
 };
 const evaluate=code=>{try{return vm.runInContext(code,context,{filename:'inline'});}catch(error){error.message+=' :: '+code.slice(0,60).replace(/\n/g,' ');throw error;}};
 const tabs=['overview','profile','clinical','history','documents','referrals','orders','visits','insurance','prescribing'].concat(billingVisible?['billing']:[]).concat(checkout?['checkout']:[]);
 evaluate(`practiceWorkspaceSettings={version:4,content:{module_order:Object.keys(workspaceModuleIds),hidden_modules:[],chart_tabs:${JSON.stringify(tabs)}}}`);
 evaluate(`globalThis.me={role:${JSON.stringify(role)},user_id:'clinician-1'};workspace={patient:{id:'patient-1'},appointments:[{id:'appt-1',status:'in_progress',title:'Office visit',clinician_id:'clinician-1'}],visits:[],amendments:[],clinical:{items:[]},labs:{orders:[],reports:[],acknowledgments:[]},billing:{accounts:${JSON.stringify(account?[account]:[])},coverages:[],copays:[]},history:null};
  activeVisit={id:${JSON.stringify(visitId)},patient_id:'patient-1',appointment_id:'appt-1',clinician_id:'clinician-1',status:${JSON.stringify(account?.status==='posted'?'signed':'in_progress')},version:3,note:null,vitals:${JSON.stringify(vitals||{})}};
  workspace.visits=[activeVisit];`);
 // The page as renderChart leaves it: the real #chart markup with the fixed-order visit host row
 // inside it. The renderers that need a back end contribute nothing; the markup under test is the
 // one read out of web/app.js, so a future edit to that markup is this test's problem.
 evaluate(`(function(){
  let tabs=[['overview','Overview'],['profile','Profile'],['clinical','Clinical'],['history','History'],['documents','Files'],['referrals','Referrals'],['orders','Orders'],['visits','Visits'],['insurance','Insurance'],['prescribing','Prescribing']];
  if(typeof configuredChartTabs==='function')tabs=configuredChartTabs(tabs);
  if(tabs.some(([key])=>key==='billing'))tabs.splice(tabs.findIndex(([key])=>key==='billing'),0,['insurance','Insurance']);
  node('chart').innerHTML=CHART_MARKUP;
  ensureVisitPageHost();
  node('encounter-progress').innerHTML=encounterWorkflow();
  // The intake and documentation sections live inside #visit-editor, where renderVisit parses
  // them. The fixture's view of them is taken after the visit block is on screen (see settle),
  // exactly as the page's getElementById would find them then.
 })();`);
 // Let queued renders land, then hand the checks the intake and documentation hosts renderVisit
 // parsed inside #visit-editor — the same nodes a page-level getElementById(id) finds there.
 const settle=async()=>{
  for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done));
  adoptParsedHosts();
 };
 return {evaluate,nodes,scrolls,notices,settle,node,live:id=>liveById(id,nodes),order:ids=>orderOf(node('chart'),ids)};
}

async function main(){
 // 1. The visit page has one scrolling page, not a numbered step bar.
 let f=fixture();
 let heading=f.evaluate('encounterWorkflow()');
 assert.match(heading,/encounter-visit-actions/,'the heading carries the visit action row');
 assert.doesNotMatch(heading,/encounter-step-tabs|Step 1|1\. Vitals/,'no numbered step bar is rendered');
 for(const label of ['Vitals','Note','Finish'])assert.ok(!new RegExp(`>(?:\\d+\\.\\s*)?${label}<`).test(heading),`"${label}" is not a step tab`);
 f.evaluate('renderVisit(false)');
 assert.equal(f.live('visit-editor').hidden,false,'the visit block is open');
 assert.equal(f.live('encounter-intake').hidden,false,'vitals sit on the same page');
 assert.equal(f.live('encounter-documentation').hidden,false,'the note sits on the same page');
 assert.equal(f.live('encounter-revenue').hidden,false,'codes & charges sit on the same page');
 assert.equal(f.live('visit-checkout').hidden,false,'payment & finish sit on the same page');

 // 2. The hosts sit in the page's order — heading, vitals and note, charges, finish — after the
 // first render, after a revenue re-render, and after switching visits.
 {
  const g=fixture();
  g.evaluate('renderVisit(false)');await g.settle();
  const PAGE=['encounter-progress','visit-editor','encounter-revenue','visit-checkout'];
  assert.deepEqual(g.order(PAGE),PAGE,'the hosts are in the visit page order after the first render');
  g.evaluate('renderEncounterRevenue()');await g.settle();
  assert.deepEqual(g.order(PAGE),PAGE,'a revenue re-render cannot move the blocks');
  g.evaluate("activeVisit={...activeVisit,id:'visit-2',version:1};workspace.visits=[activeVisit];renderVisit(false);renderEncounterRevenue();");await g.settle();
  assert.deepEqual(g.order(PAGE),PAGE,'switching visits keeps the order');
  assert.equal(g.order(['encounter-diagnoses','encounter-billing-editor','encounter-claims']).slice(0,1).join(), 'encounter-diagnoses','diagnoses sit above the part of the block that re-renders');
 }

 // 3. The old step keys stay accepted and land on the visit page itself.
 for(const [key,expectedScroll] of [['intake','encounter-intake'],['documentation','note-form'],['charges','encounter-revenue'],['checkout','visit-checkout']]){
  const g=fixture();
  g.evaluate('renderVisit(false)');g.scrolls.length=0;g.evaluate(`setEncounterSection('${key}')`);await g.settle();
  assert.equal(g.evaluate('encounterSection'),key,`"${key}" stays addressable for saved routes`);
  assert.equal(g.evaluate('encounterShows("charges")'),true,`"${key}" still answers as the visit page`);
  assert.equal(g.evaluate('chartSection'),'visits',`"${key}" stays inside the encounter`);
  assert.equal(g.live('visit-editor').hidden,false,`"${key}" keeps the whole page open`);
  assert.equal(g.live('encounter-intake').hidden,false,`"${key}" keeps vitals on the same page`);
  assert.equal(g.live('encounter-documentation').hidden,false,`"${key}" keeps the note on the same page`);
  assert.equal(g.live('encounter-revenue').hidden,false,`"${key}" keeps the charges block open`);
  assert.equal(g.live('visit-checkout').hidden,false,`"${key}" keeps the payment block open`);
  if(expectedScroll)assert.ok(g.scrolls.includes(expectedScroll),`${key} did not scroll: ${JSON.stringify(g.scrolls)}`);
 }
 {
  const g=fixture();
  g.evaluate('renderVisit(false)');g.evaluate("setEncounterSection('charges')");await g.settle();
  assert.equal(g.evaluate('encounterShows("charges")'),true,'the charges block stays answered from the charges key');
  assert.ok(g.evaluate('getRenders()').revenue>=2,'the charges block is rendered when named');
 }

 // 4. Hiding billing or checkout keeps a single page: the blocks vanish, nothing re-steps.
 {
  const g=fixture({billing:false});
  g.evaluate('renderVisit(false)');
  assert.equal(g.evaluate('visitBillingAreaVisible()'),false,'the hidden billing tab removes the charges area');
  assert.equal(g.live('encounter-revenue').hidden,true,'billing hidden by the practice removes the charges block');
  assert.equal(g.live('visit-editor').hidden,false,'the note page is unchanged');
  assert.equal(g.live('visit-checkout').hidden,false,'checkout is unaffected');
  assert.match(g.evaluate('encounterWorkflow()'),/encounter-visit-actions/,'still one page, not a step bar');
 }
 {
  const g=fixture({checkout:false});
  g.evaluate('renderVisit(false)');
  assert.equal(g.evaluate('visitCheckoutAreaVisible()'),false,'the hidden checkout tab removes the payment block');
  assert.equal(g.live('visit-checkout').hidden,true,'checkout hidden by the practice removes the payment block');
  assert.equal(g.live('visit-editor').hidden,false,'the rest of the page stays');
  assert.equal(g.live('encounter-revenue').hidden,false,'charges are unaffected');
 }

 // 5. Recorded vitals collapse to one summary line with an Edit vitals button; an unrecorded
 // visit shows today's form as it always has.
 {
  const g=fixture({vitals:{systolic_mm_hg:120,diastolic_mm_hg:80,heart_rate_bpm:72,weight_kg:45}});
  g.evaluate('renderVisit(false)');
  // The page the checks read: the editor's markup with the closed <template> taken out — in a
  // browser the template's content is a separate document, not part of the page's visible DOM.
  const intake=g.evaluate('(function(){const editor=$("visit-editor");const held=editor.querySelector("#vitals-form-holder");const backup=held?held.parentElement:null;const next=held?held.nextSibling:null;if(held)held.remove();const html=editor.innerHTML;if(held&&backup)backup.insertBefore(held,next);return html;})()');
  assert.ok(intake.includes('visit-vitals-summary'),'the vitals block renders');
  assert.match(intake,/id="visit-vitals-summary"/,'the recorded vitals show one summary line');
  assert.match(intake,/BP 120\/80/,'the line carries the blood pressure');
  assert.match(intake,/Pulse 72/,'and the pulse');
  assert.match(intake,/Weight 45 kg/,'and the weight');
  assert.match(intake,/data-action="edit-vitals">Edit vitals</,'with an Edit vitals button');
  assert.doesNotMatch(intake,/<form id="vitals-form"[^>]*><div class="form-grid/,'the full grid is not standing open on the page');
  assert.ok(g.evaluate('(function(){const held=$("vitals-form-holder");return Boolean(held&&held.innerHTML.includes("id=\\"vitals-form\\""));})()'),'today\u2019s form stays ready inside the closed template');
  // Edit vitals puts the form back in the page, where it is the live #vitals-form again.
  g.evaluate('openVitalsForm()');
  assert.match(g.evaluate('String(($("visit-editor").querySelector("#vitals-form")||{}).outerHTML||"")'),/id="vitals-form"/,'Edit vitals opens the form on the page');
  const empty=fixture();
  empty.evaluate('renderVisit(false)');
  assert.match(empty.nodes['visit-editor'].innerHTML,/<form id="vitals-form"/,'a visit with nothing recorded shows today\u2019s form');
  assert.doesNotMatch(empty.nodes['visit-editor'].innerHTML,/id="visit-vitals-summary"/,'and no summary line');
  assert.equal(empty.evaluate('typeof $("vitals-form-holder")'),'object','and nothing sits in a template');
  assert.equal(empty.evaluate('$("vitals-form-holder")'),null,'the form is in the page itself');
 }

 // 6. Exactly one diagnoses editor, always at the top of codes & charges — draft visit with the
 // open charge table, posted visit with the closed table — and the note never doubles it.
 {
  // Draft visit, charge table open.
  const draftAccount={id:'account',version:7,status:'draft',content:{visit_id:'visit-1',service_date:'2026-11-13',currency:'USD',lines:[]}};
  const g=fixture({account:draftAccount});
  g.evaluate('renderVisit(false)');await g.settle();
  void g.evaluate('openEncounterCharges()');await g.settle();
  const found=g.evaluate(`(function(){let n=0;(function walk(node){if(!node||!node.children)return;for(const child of node.children){if(child.id==='visit-diagnoses')n++;walk(child);}})($('chart'));return n;})()`);
  assert.equal(found,1,'draft visit with an open charge table still has one #visit-diagnoses');
  const revenueOrder=g.evaluate(`orderOf($('encounter-revenue'),['encounter-diagnoses','encounter-revenue-status','encounter-billing-editor'])`);
  assert.deepEqual(revenueOrder,['encounter-diagnoses','encounter-revenue-status','encounter-billing-editor'],'ICD reads above the charge lines');
  assert.doesNotMatch(g.evaluate('String($("visit-editor").innerHTML)'),/id="visit-diagnoses"/,'with charges on screen the note does not draw its own diagnoses editor');
  assert.equal(g.evaluate('visitNoteOwnsDiagnoses()'),false);
  // A re-render keeps the one editor in its stable host. A re-render of the same visit at the same
  // revision is served from the block's cache key, so each re-render below moves the visit's
  // revision first: that is the case where the block rewrites its own markup.
  g.evaluate('activeVisit={...activeVisit,version:activeVisit.version+1};');
  g.evaluate('renderEncounterRevenue()');await g.settle();
  const again=g.evaluate(`(function(){let n=0;(function walk(node){if(!node||!node.children)return;for(const child of node.children){if(child.id==='visit-diagnoses')n++;walk(child);}})($('chart'));return n;})()`);
  assert.equal(again,1,'a charge re-render never grows a second editor');
  // The editor mid-typing survives that re-render as the very nodes it was typed into. The block
  // rebuilds its markup on every re-render, so a form left inside it would come back re-parsed —
  // and a re-parsed form has lost every key typed into it that has not saved yet.
  g.evaluate('(function(){const input=$("visit-diagnoses").querySelector("input");input.value="E11.9 being typed";})()');
  g.evaluate('globalThis.__form=$("visit-diagnoses-form");globalThis.__body=$("encounter-revenue-status");');
  assert.equal(g.evaluate('String(Boolean(globalThis.__form&&globalThis.__body))'),'true','the editor and the block body are both on screen before the re-render');
  g.evaluate('activeVisit={...activeVisit,version:activeVisit.version+1};');
  g.evaluate('renderEncounterRevenue()');await g.settle();
  assert.equal(g.evaluate('String(globalThis.__body!==$("encounter-revenue-status"))'),'true','sanity: this re-render did rebuild the rest of the block');
  assert.equal(g.evaluate('$("visit-diagnoses-form").querySelector("input").value'),'E11.9 being typed','a charge re-render leaves the typed diagnosis on the page');
  assert.equal(g.evaluate('globalThis.__form===$("visit-diagnoses-form")'),true,'while the form on screen is still the node it was typed into, not one parsed out of markup');
  assert.equal(g.evaluate('$("encounter-diagnoses").querySelectorAll("#visit-diagnoses-form").length'),1,'the stable host holds exactly one editor');
  assert.equal(g.evaluate('$("encounter-diagnoses").children.length'),1,'and nothing else besides it');
  assert.equal(g.evaluate(`(function(){let n=0;(function walk(node){if(!node||!node.children)return;for(const child of node.children){if(child.id==='visit-diagnoses')n++;walk(child);}})($('chart'));return n;})()`),1,'and exactly one editor anywhere on the page');
 }

 // 7. Orders and Files are areas of their own: whole screen, single Back to visit button.
 {
  const g=fixture();
  g.evaluate('renderVisit(false)');g.evaluate("setEncounterSection('orders')");await g.settle();
  assert.equal(g.evaluate('encounterSection'),'orders','the Orders area is its own state');
  assert.equal(g.live('visit-editor').hidden,true,'the visit page steps away while Orders is open');
  assert.equal(g.live('encounter-revenue').hidden,true);
  assert.equal(g.live('visit-checkout').hidden,true,'checkout stays away while another area is open');
  assert.equal(g.live('encounter-orders-actions').hidden,false,'the orders action panel opens');
  heading=g.evaluate('encounterWorkflow()');
  assert.match(heading,/data-encounter-back[^>]*>← Back to visit</,'the area offers Back to visit');
  assert.doesNotMatch(heading,/data-encounter-step="new-order"|data-chart-section="referrals"/,'the normal visit actions are not doubled up on the area screen');
  g.evaluate("setEncounterSection('visit')");await g.settle();
  assert.equal(g.evaluate('encounterSection'),'visit','Back to visit returns to the page');
  assert.equal(g.live('visit-editor').hidden,false);
  assert.equal(g.live('visit-checkout').hidden,false,'the whole page comes back');
  assert.match(g.evaluate('encounterWorkflow()'),/encounter-visit-actions/,'and the action row is back');
 }
 {
  const g=fixture();
  g.evaluate('renderVisit(false)');g.evaluate("setEncounterSection('files')");await g.settle();
  assert.equal(g.evaluate('encounterSection'),'files','the Files area is its own state');
  assert.equal(g.live('visit-editor').hidden,true);
  assert.equal(g.live('documents-panel').hidden,false,'the encounter files panel opens');
  assert.ok(g.evaluate('getRenders()').files>=1,'the files area renders its list');
  assert.match(g.evaluate('encounterWorkflow()'),/data-encounter-back/,'Files offers Back to visit');
  g.evaluate("setEncounterSection('visit')");await g.settle();
  assert.equal(g.live('visit-editor').hidden,false,'Back to visit leaves Files');
 }

 console.log('PASS the visit is one scrolling page in host order through re-renders and visit switches; vitals stay compact; one diagnoses editor above the charge lines; old step keys land on it; record areas take the screen until Back to visit');
}
main().catch(error=>{console.error(error.message);process.exit(1);});
