// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The one line under the charge table. A doctor working in an encounter's charges asked where the
// charges are actually sent from; the encounter billing card above the table has always known the
// next step, and the table had nothing to say. This script opens an encounter's charge table with the
// billing step holding each state in turn, and checks the table now says the same next step the
// card says, in the same plain words, once only, and nothing at all when the encounter has no charge
// step left. The DOM is the same small hand-written element stub the other charge UI scripts use;
// web/billing.js, web/visit-billing.js, web/visit-review.js and web/patient-revenue.js are loaded
// into a node vm and driven through the handlers they install on the document. Every value below
// is synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

// ---- the hand-written DOM --------------------------------------------------------------
const PROP_ALIAS={colspan:'colSpan'};
const VOID_TAGS=new Set(['input','br','img','meta','link','hr','source']);
function parseMarkup(html){
 // Inside a <select> the selected option is the value; a bare <option selected> marks itself.
 const insideSelect={depth:0};
 const stack=[];const roots=[];
 const re=/<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;let last=0,match;
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
  if(!selfClose&&!VOID_TAGS.has(tag))stack.push(node);
 }
 if(top())top()._text+=html.slice(last);
 return roots;
}
function camel(name){return name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase());}
const dashed=key=>key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
let uid=0;
function makeNode(tag){
 const node={_id:++uid,tag:tag||'fragment',attrs:Object.create(null),children:[],_text:'',parent:null,_value:'',open:false};
 node.dataset=new Proxy(Object.create(null),{
  get:(map,key)=>key in map?map[key]:undefined,
  set:(map,key,value)=>{map[key]=String(value);node.attrs['data-'+dashed(String(key))]=String(value);return true;},
  has:(map,key)=>key in map,
  deleteProperty:(map,key)=>{delete map[key];return true;},
  ownKeys:map=>Object.keys(map),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
 Object.defineProperty(node,'value',{get:()=>node._value,set:v=>{node._value=String(v);}});
 Object.defineProperty(node,'textContent',{
  get(){if(tag==='select'&&!node._text){const option=node.children[node.selectSelected??0];return option?option.textContent:'';}
   return node._text+node.children.map(child=>child.textContent).join('');},
  set(text){node._text=String(text);node.children.length=0;}});
 Object.defineProperty(node,'innerHTML',{
  get(){return (node._text||'')+node.children.map(child=>child.outerHTML).join('');},
  set(html){node.children.forEach(child=>{child.displaced=true;unregister(child);delete child.displaced;child.parent=null;});node.children=[];node._text='';for(const child of parseMarkup(String(html)))insertChild(node,child);}});
 Object.defineProperty(node,'outerHTML',{get(){return serialize(node);}});
 Object.defineProperty(node,'lastElementChild',{get(){return node.children.at(-1)??null;}});
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
 node.replaceChildren=(...parts)=>{node.children.forEach(child=>{child.displaced=true;unregister(child);delete child.displaced;child.parent=null;});node.children=[];node._text='';node.append(...parts);};
 node.remove=()=>{if(!node.parent)return;const siblings=node.parent.children,index=siblings.indexOf(node);if(index>=0)siblings.splice(index,1);node.parent=null;node.displaced=true;unregister(node);delete node.displaced;};
 node.focus=()=>{documentStub.activeElement=node;};
 node.scrollIntoView=()=>{};
 node.insertAdjacentHTML=(where,html)=>{
  const parts=parseMarkup(String(html));
  if(where==='afterbegin'){parts.reverse().forEach(part=>{part.parent=node;node.children.unshift(part);register(part);});return;}
  parts.forEach(part=>insertChild(node,part));};
 if(tag==='tr'){node.cells=node.children.filter(child=>child.tag==='td');node.cells.item=index=>node.cells[index]||null;}
 if(tag==='form'){
  node.elements=new Proxy(Object.create(null),{get:(_,name)=>{if(typeof name!=='string')return undefined;return node.querySelectorAll(`[name="${name}"]`)[0];},has:(target,name)=>queryAll(node,`[name="${name}"]`).length>0,ownKeys:()=>{const names=new Set();for(const field of queryAll(node,'[name]'))names.add(field.attrs.name);return [...names];},getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});
 }
 return node;
}
function insertChild(parent,child){
 if(parent.tag==='table'&&child.tag==='tr'){
  let body=parent.children.find(cell=>cell.tag==='tbody');
  if(!body){body=makeNode('tbody');body.parent=parent;parent.children.push(body);}
  parent=body;}
 child.parent=parent;parent.children.push(child);register(child);
}
// Every id inside the subtree leaves the registry with it: a page's getElementById only answers
// for what is on screen, and markup written over is not.
// What a subtree that really leaves the document costs the registry: its own id only if another
// element has taken it over, and the ids of everything inside it, which the page can no longer
// find. An element written over from the outside keeps its own id — that is what a page's
// getElementById answers for when the page rewrites a panel's contents.
function unregister(node){
 if(node.attrs.id&&node.displaced)delete nodes[node.attrs.id];
 node.isConnected=false;
 for(const child of node.children)unregister(child);
}
// A subtree written over leaves the document, ids and all; the next write registers whatever it
// carries, which is how a page's getElementById only ever finds what is really on screen.
function register(node){
 if(node.attrs.id&&nodes[node.attrs.id]!==node){
  const previous=nodes[node.attrs.id];
  if(previous){previous.displaced=true;unregister(previous);delete previous.displaced;const at=previous.parent?.children.indexOf(previous);if(at>=0)previous.parent.children.splice(at,1);previous.parent=null;}
  nodes[node.attrs.id]=node;node.isConnected=true;}
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
 const attrs=Object.entries(node.attrs).map(([name,value])=>value===true?` ${name}`:` ${name}="${value}"`).join('');
 if(node.tag==='input')return `<input${attrs}>`;
 const inner=node.tag==='select'
  ?node.children.map((option,index)=>`<option${String(option.attrs.value??'')===''?'':` value="${option.attrs.value}"`}>${option.textContent}</option>`).join('')
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
const openHost=html=>{const host=makeNode('div');host.innerHTML=html;return host;};
// The billing step, laid out as the encounter's Charges screen lays it out.
function buildPanels(){
 for(const id of Object.keys(nodes))delete nodes[id];
 // The panels the encounter's Charges step is made of, each findable by id the way the page finds it.
 const revenue=makeNode('div');revenue.attrs.id='encounter-revenue';nodes['encounter-revenue']=revenue;
 for(const [id,tag] of [['encounter-revenue-status','div'],['visit-billing-review','section'],['encounter-billing-editor','div'],['encounter-charge-details','details'],['encounter-billing-detail','div']]){
  const panel=makeNode(tag);panel.attrs.id=id;nodes[id]=panel;revenue.append(panel);
 }
 nodes['visit-billing-review'].hidden=true;
 documentStub.activeElement=null;
}

// ---- the synthetic visit ---------------------------------------------------------------
const {visitSummary,selfPay}=require('./visit_billing_fixture.cjs');
// The one-page visit lays the charge table out compactly, with the encounter and its options behind a
// disclosure; a draft charge table for an encounter is only ever entered that way, so the stub's form
// The stub's form element answers for the hidden selects behind the compact table's disclosure
// the way a browser's does: the encounter the table is on, and the coverage its insurance runs through.
const hiddenSelectAnswer=html=>html
 .replace('<select name="visit_id" required>','<input type="hidden" name="visit_id" value="visit" required>')
 .replace('<select name="coverage_id"><option value="">Self-pay / no selected coverage</option>','<select name="coverage_id" required><option value="coverage" selected>Synthetic Medicare PPO</option>');
const realParseMarkup=parseMarkup;
parseMarkup=function(html){return realParseMarkup(hiddenSelectAnswer(String(html)));};
// Named rather than `line`: web/visit-review.js has a real page bug where its charge-line mapper
// shadows itself inside a map callback, and a test global called line used to paper over it.
const chargeLine={code_system:'CPT',code:'99213',description:'Synthetic office visit',modifiers:'',units:1,amount_cents:15000,diagnosis_codes:['Z00.00']};
const accountOf=(status='posted',version=2)=>({id:'account',version,status,patient_id:'patient',total_cents:28000,content:{visit_id:'visit',service_date:'2026-11-12',coverage_id:'coverage',lines:[{...chargeLine}],notes:''}});
// The charge account the claim's copy of the encounter is taken from: a frozen payer on file, and the
// charge lines the claim carries.
const reviewAccount={id:'account',patient_id:'patient',version:5,status:'posted',total_cents:28000,content:{visit_id:'visit',service_date:'2026-11-12',lines:[{code_system:'CPT',code:'99213',description:'Synthetic office visit',units:1,amount_cents:28000,diagnosis_codes:['Z00.00']}]},coverage_snapshot:{coverage:{content:{relationship:'self',member_id:'SYN-MEMBER'}},payer:{content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}}}};
const coverage={id:'coverage',version:2,content:{payer_id:'payer',priority:'primary',status:'active',effective_date:'2026-01-01',end_date:null,member_id:'SYN-MEMBER',copay_cents:null}};
const appointment={id:'appointment',starts_at:'2026-11-12T15:00:00Z',timezone:'America/Chicago',status:'checked_in',title:'Office visit'};

const ctx={console,Date,Intl,URL,URLSearchParams,Map,Set,WeakMap,WeakSet,Array,Math,Number,String,JSON,Object,Boolean,RegExp,Error,Promise,Symbol,encodeURIComponent,
 document:documentStub,localStorage:{getItem:()=>null,setItem(){},removeItem(){}},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
 crypto:{randomUUID:()=>'synthetic-request'},setTimeout:()=>0,clearTimeout(){},
 selected:'patient',me:{role:'owner'},chartSection:'visits',encounterSection:'charges',billingSelected:null,
 activeVisit:{id:'visit',appointment_id:'appointment',status:'signed',version:3},
 workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{}},appointments:[appointment],visits:[{id:'visit',appointment_id:'appointment',status:'signed'}],billing:{accounts:[],coverages:[coverage],entries:[],copays:[]}},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 human:v=>String(v??'').replaceAll('_',' '),date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),cents:v=>Math.round(Number(v)*100),
 payerName:()=>'Synthetic Medicare PPO',billingCan:()=>true,workspaceResourceAllowed:()=>true,
 // The payer directory the billing screens read: this encounter's insurer, with its Claim.MD payer ID.
 billingPayers:[{id:'payer',content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}}],
 claimmdClaimProviderDefaults:()=>({}),claimPatientAddressDefault:()=>('1 Synthetic Way, Synthetic City, SY 00000, US'),
 claimMdConnectionState:{connected:true},loadClaimMdConnection:async()=>{},claimsApiBase:'/api/v1/billing/claims',$:id=>documentStub.getElementById(id),
 visitBillingDate:v=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${v}T00:00:00`)),
 revenueCoverage:()=>null,revenueServiceDate:()=>'2026-11-12',accountDiagnosisSummary:()=>'',accountDiagnosisDraftRecovery:()=>'',billingChargeDraftRecovery:()=>'',
 billingCoverageOrderMarkup:()=>'',visitPlanCopayCents:()=>null,hostedCopayPanel:()=>'',loadHostedCopays:async()=>null,
 notice(message){ctx.noticed=message;},confirmAction:async()=>true,run:fn=>{ctx.pending=Promise.resolve().then(fn);return ctx.pending;},
 showChartSection(){},setEncounterSection(section){ctx.sectionOpened=section;},showEncounterSection(){},showBillingAccount(){},openBillingEditor(html){const host=ctx.billingEditorHost();if(host)host.innerHTML=html;},
 billingEditorHost(){return (ctx.chartSection==='insurance'&&$('insurance-editor'))||(ctx.chartSection==='visits'&&$('encounter-billing-editor'))||$('billing-editor');},
 billingDetailHost(){return ctx.chartSection==='visits'&&$('encounter-billing-detail')||$('billing-detail');},
 showEncounterClaim:async id=>{ctx.openedClaim=id;},claimEditor:()=>{},refreshEncounterProgress(){},
 // The encounter is reopened through the chart's own way back to a patient: recorded here so a test can
 // see the screen went that way rather than somewhere else.
 selectPatient:async()=>{ctx.sent.push(['rerender']);},
  // A visit-summary reply hands back what the server now says, the same summary shape the card was
 // last drawn from, so a refresh after a post has something real to draw.
 api:async(url,method='GET',body,version)=>{ctx.sent.push([url,method,body,version]);
  if(String(url).includes('/visit-summary'))return ctx.nextSummary?ctx.nextSummary:vm.runInContext('encounterRevenueState.data?.summary||{}',ctx);
  return {};}};
ctx.reviewAccount=reviewAccount;
const context=vm.createContext(ctx);
ctx.sent=[];
ctx.globalThis=ctx;
vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/billing.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/visit-billing.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/visit-review.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),context);
vm.runInContext('encounterRevenueState={patient:null,identity:null,account:null,pending:null,data:null,loadedAt:0};',ctx);
// The payer directory belongs to web/billing.js, which owns it as a script-level binding; the
// visit's insurer and its Claim.MD payer ID are put there the way the billing screen fills it.
vm.runInContext('billingPayers=[{id:\'payer\',content:{name:\'Synthetic Medicare PPO\',payer_code:\'SYN\'}}];',ctx);

const $=id=>documentStub.getElementById(id);
const openForm=()=>$('billing-account-form');
// A step is identified by what its button carries: its own data- attributes. Neither the element's
// type nor its class is part of the step, whatever shape the markup or the DOM happens to leave
// them in.
const stepAttributes=attributes=>String(attributes).match(/\sdata-[a-z-]+(?:="[^"]*")?/g)?.map(name=>name.trim()).filter(name=>!/^data-(class|type)(=|$)/.test(name)).join(' ')||'';
// The card's primary button, straight out of the markup the billing step wrote — not through the
// DOM, which mirrors an element's class onto its own class attribute and would read the first
// class in the markup rather than the button the card actually offers.
const cardButton=()=>{
 const html=$('encounter-revenue-status').innerHTML;
 const tag=/<button[^>]*class="primary"[^>]*>/.exec(html)?.[0]||'';
 const label=/<button[^>]*class="primary"[^>]*>([^<]*)</.exec(html)?.[1]||'';
 return {attribute:tag.replace(/^<button/,'').replace(/>$/,''),label,html};
};
// The line under the table, read as the person reads it.
// The line only exists on a table that is on screen; an encounter with no live table is given nothing.
const nextLine=()=>{
 const node=openForm()?.querySelector('.charge-table-next');if(!node)return null;
 const button=node.querySelector('button');
 // A step is known by the data- attribute its markup carries with a value of its own. The stub
 // mirrors an element's own type="" and class="" onto data-type and data-class, and those say
 // nothing about the step, so they are left out of what the line is identified by.
 const written=button?Object.entries(button.attrs).map(([name,value])=>value===true?name:`${name}="${value}"`).join(' '):'';
 return {text:node.querySelector('span')?.textContent??'',label:button?.textContent??'',attribute:stepAttributes(written)};
};
// A claim carrying everything a send needs: the practice's billing setup, the patient's address,
// the policy holder's details, a place of service and the diagnoses. What the review reads is what
// the claim itself holds, so a claim put together by the practice shows the send button open.
const claimContent=()=>({billing_provider_name:'Synthetic Care Group',billing_address:'1 Synthetic Way',tax_id:'123456789',billing_npi:'1234567890',rendering_npi:'0987654321',billing_taxonomy:'207R00000X',patient_address:'1 Synthetic Way',subscriber_address:'1 Synthetic Way',subscriber_birth_date:'1980-01-01',place_of_service:'11',diagnosis_codes:['Z00.00'],line_diagnosis_pointers:[[1]]});
const claimReady=(over={})=>({id:'claim',status:'ready',version:2,payer_name:'Synthetic Medicare PPO',automatic:true,content:claimContent(),snapshot:{account:ctx.reviewAccount,patient:{given_name:'Synthetic',family_name:'Patient'}},issues:[],...over});
// The encounter is opened on its Charges step with the billing step holding this encounter's summary,
// then its charges are opened the way staff open them: the card's own button.
// The billing step holding this encounter's summary, as an encounter-summary reply leaves it: the same
// patient, sign-in, visit and account the screen is on, and its card drawn from this summary.
const stepFor=(summary,version)=>{
 const step={patient:'patient',identity:ctx.me,visit:'visit',visitStatus:ctx.activeVisit?.status,account:'account',version,pending:null,data:{summary},loadedAt:Date.now(),filter:'all',prepared:true,review:null,reviewCard:summary};
 ctx.step=step;
 vm.runInContext('encounterRevenueState=step',ctx);
 return step;
};
// The card's own way into the table is only offered while the charges can still be changed. On a
// visit whose charges are posted the step answers with a read-only table, and the person gets
// there the same way: the step's Charges disclosure, opened the way the step itself opens it.
const enterTable=async()=>{
 const card=$('encounter-revenue-status');
 const edit=card?.querySelector('[data-encounter-charges]');
 if(edit){click(edit);}
 else if($('encounter-charge-details')&&$('encounter-billing-detail')?.innerHTML)vm.runInContext('openEncounterCharges()',ctx);
 await settle();
};
// An encounter opened on the step it is actually opened on: the chart on Visits, the encounter panel
// built with the step chosen, then the step itself drawn. The page builds the charge table itself
// in one case only — an encounter with no charges of its own — so an encounter that has them is entered the
// way staff enter it, by pressing the card's own way in.
const openCharges=async summary=>{
 buildPanels();
 const record=accountOf(summary.account?.status||'posted',summary.account?.version||2);
 ctx.workspace.billing.accounts=[record];
 ctx.encounterSection='charges';
 vm.runInContext('billingSelected=null;chargeTableBaselines=new WeakMap();billingChargeDrafts.clear();encounterRevenueState={patient:null,identity:null,account:null,pending:null,data:null,loadedAt:0};',ctx);
 stepFor(summary,record.version);
 vm.runInContext('renderEncounterRevenue()',ctx);
 if(!$('encounter-revenue-status'))throw new Error('the billing step drew no card for this encounter');
 await enterTable();
 return openForm();
};
const settle=async()=>{for(let step=0;step<40;step++)await new Promise(resolve=>setImmediate(resolve));};

(async()=>{
 // ---- 1. the note has to be signed first ------------------------------------------------
 const unsigned={...visitSummary({state:'sign_visit',waiting_on:'clinician',account:{id:'account',status:'draft',version:2},balance_cents:null,claim:null,insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:true,status:'not_billed',pending_cents:27000,unassigned_cents:0},patient:{copay_cents:null,copay_paid_cents:null,copay_due_cents:null,received_cents:0,receipts_applied_cents:0,owes_now_cents:0,responsibility_source:'not_final'}}),visit:{id:'visit',status:'in_progress',appointment_id:'appointment'}};
 ctx.activeVisit={id:'visit',appointment_id:'appointment',status:'in_progress',version:3};
 let form=await openCharges(unsigned);
 assert.ok(form,'the charges table is on screen');
 let line1=nextLine();
 assert.deepEqual(line1,{text:'Sign the encounter note to send these charges.',label:'Open the encounter note',attribute:'data-revenue-documentation'});
 assert.equal(stepAttributes(cardButton().attribute),'data-revenue-documentation','the footer names the same next step as the card');
 // The line sits directly under the table, after its last line and before anything else.
 const editor=nodes['encounter-billing-editor'].innerHTML;
 assert.ok(editor.indexOf('id="billing-charge-lines"')<editor.indexOf('data-charge-next'),'the next step sits under the charge lines');
 assert.ok(editor.indexOf('data-add-charge')<editor.indexOf('data-charge-next'),'and under the add-a-line button that belongs to the table');
 assert.ok(editor.indexOf('data-charge-next')<editor.indexOf('<details class="charge-more-options"'),'ahead of the fee and notes options');
 // Pressing it opens the encounter note, through the hook the card's button uses. The step was opened
 // by pressing something first, and opening a step is the page's own business, so the record of
 // what the footer pressed is taken from here on, not from the trip to the charge table.
 // Anything the trip to the charge table left in flight is settled before the footer is pressed,
 // so what the footer itself does is all that is left on the record.
 await settle();
 ctx.sectionOpened=null;ctx.sent.length=0;
 click($('billing-charge-lines').closest('form').querySelector('.charge-table-next button'));
 assert.equal(ctx.sectionOpened,'documentation','the footer button opens the encounter note');
 assert.equal(ctx.sent.length,0,'nothing is sent by opening the note');

  // ---- 2. the charges can be posted ------------------------------------------------------
  // Insurance that can be billed electronically gets the one button that does the whole job.
  const post=visitSummary({state:'post_charges',waiting_on:'staff',account:{id:'account',status:'draft',version:2},balance_cents:null,claim:null,insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:true,status:'not_billed',pending_cents:27000,unassigned_cents:0},patient:{copay_cents:null,copay_paid_cents:null,copay_due_cents:null,received_cents:0,receipts_applied_cents:0,owes_now_cents:0,responsibility_source:'not_final'}});
  ctx.activeVisit={id:'visit',appointment_id:'appointment',status:'signed',version:3};
  await openCharges(post);
  line1=nextLine();
  assert.equal(line1.label,'Post charges and review claim');assert.equal(line1.attribute,'data-visit-review-open="account" data-post-and-send="account"');
  assert.equal(stepAttributes(cardButton().attribute),'data-visit-post-charges="account"','the card still asks for its own post; the line under the table does the whole chain');
  // Pressing it is one press that does the whole job: the same confirm the card's own post asks,
  // with the send named in it, then exactly the post the lower form would send. The claim the
  // server prepares next lands in prepare_claim, so nothing further is sent here.
  const posted=visitSummary({...post,state:'prepare_claim',waiting_on:null,account:{id:'account',status:'posted',version:3},insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:true,status:'not_billed',pending_cents:27000,unassigned_cents:0},patient:{copay_cents:null,copay_paid_cents:null,copay_due_cents:null,received_cents:0,receipts_applied_cents:0,owes_now_cents:0,responsibility_source:'not_final'}});
  ctx.nextSummary=posted;
  ctx.answer=true;ctx.sent.length=0;ctx.noticed=null;ctx.pending=Promise.resolve();
  const asked=[],asker=async(message,options)=>{asked.push([message,options.title,options.confirmLabel]);return ctx.answer;};
  ctx.asker=asker;vm.runInContext('confirmAction=(message,options)=>asker(message,options)',ctx);
  click(openForm().querySelector('.charge-table-next button'));await settle();await ctx.pending;await settle();
  vm.runInContext('confirmAction=async()=>true',ctx);
  assert.deepEqual(asked,[['Charges of $280.00 become final. Review and submit the claim on the Claim.MD form.','Post these charges?','Post charges']],'posting confirms charges; sending is confirmed on the Claim.MD form');
  const posts=()=>ctx.sent.filter(call=>String(call[0]).endsWith('/actions'));
  assert.deepEqual(posts().map(call=>[call[0],call[1],JSON.stringify(call[2]),call[3]]),[['/api/v1/patients/patient/billing/accounts/account/actions','POST','{"action":"post","reason":"Charges posted","local_only":false}',2]],'the lower form\'s endpoint, action, a default reason and the account version');
  assert.ok(ctx.sent.some(call=>call[0]==='rerender'),'the encounter is reopened the way the lower form reopens it');
  assert.ok(ctx.sent.findIndex(call=>call[0]==='/api/v1/patients/patient/billing/visit-summary?visit_id=visit')>ctx.sent.findIndex(call=>call[0]==='rerender'),'the refreshed card reads the updated server summary');
  assert.equal(ctx.noticed,'Charges posted.','the screen says the charges were posted, not something else');
  // The line under the table moves with the card: a posted visit has its charges on their way, not
  // a post to press.
  // A draft the practice chose to keep, and a claim that is not about charges at all, leave the
  // table with nothing to press: the card above carries the step, not the line under the lines.
  const kept=nextLine();
  assert.ok(kept===null||kept.label==='Post charges','the footer either steps aside or asks for the post, never a send');

  // ---- 3. the claim is ready, and one press sends it --------------------------------------
  // An encounter whose charges are already posted has no live table to work in — the card's Charges
  // disclosure holds them read-only — so its send is taken from the card's own button, and the
  // footer's one send is checked on a draft the practice is still working.
  const ready=visitSummary({state:'send_claim',account:{id:'account',status:'posted',version:5},claim:claimReady()});
  ctx.activeVisit={id:'visit',appointment_id:'appointment',status:'signed',version:3};
  await openCharges(ready);
  assert.equal(nextLine(),null,'a visit whose charges are final has no live table, so no line under it');
  assert.equal(stepAttributes(cardButton().attribute),'data-visit-claim-direct-send="claim"','the card itself offers the one send');
  // The same visit with its charges still a draft does have a live table, and its line sends the
  // claim the same one press the card does, with the small review link beside it — one send, not
  // two buttons.
  const draftReady=visitSummary({...ready,account:{id:'account',status:'draft',version:5}});
  await openCharges(draftReady);
  line1=nextLine();
  assert.equal(line1.label,'Send claim to Synthetic Medicare PPO');assert.equal(line1.attribute,'data-visit-claim-direct-send="claim"','the footer sends the claim itself, as the card does');
  assert.match(nodes['encounter-billing-editor'].innerHTML,/class="text-button" data-visit-review-open="account">Review claim</,'and the line keeps a small review link beside it');
  // Pressing the small link opens the review panel; the line under the table is not asked to press
  // the same thing twice while the panel is open.
  const reviewLink=openForm().querySelector('.charge-table-next [data-visit-review-open]');
  assert.ok(reviewLink,'the footer offers its one small review link');
  ctx.sent.length=0;click(reviewLink);await settle();
  assert.equal($('visit-billing-review').hidden,false,'the review panel opens');
 const panel=vm.runInContext('visitReviewPanelMarkup(encounterRevenueState.data.summary,visitReviewContext())',ctx);
 assert.match(panel,/data-visit-review-send/,'the panel holds the send itself');
 assert.equal(ctx.sent.filter(call=>call[1]&&call[1]!=='GET').length,0,'Review claim never sends a payment or claim');
 // A claim that needs details is answered the same way: one send, not two buttons.
 // A claim that needs details is answered the same way, on a table the practice can still work in:
 // one send handed to the review panel, offered once and not twice.
 const fix=visitSummary({...ready,state:'fix_claim',account:{id:'account',status:'draft',version:5},claim:claimReady({status:'draft',issues:[{code:'tax_id',missing:'billing organization tax ID'}]})});
 await openCharges(fix);
 assert.equal(nextLine().label,'Review and send claim');
 assert.equal((nodes['encounter-billing-editor'].innerHTML.match(/data-visit-review-open/g)||[]).length,1,'the table offers the send once');

 // ---- 4. a state that is not about charges says nothing ---------------------------------
 for(const summary of [
  // An encounter whose charges are no longer on the table at all — the card is what staff are looking
  // at, and its table has to be opened before anything can be typed — is given no line either.
  visitSummary({state:'waiting_insurer',waiting_on:'insurer',account:{id:'account',status:'posted',version:6},insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:true,status:'waiting',sent_on:'2026-11-12',pending_cents:27000,unassigned_cents:0},claim:{id:'claim',status:'submitted',sent_on:'2026-11-12'}}),
  selfPay({state:'paid_in_full',waiting_on:'nobody',account:{id:'account',status:'posted',version:7},patient:{copay_cents:null,received_cents:28000,receipts_applied_cents:28000,owes_now_cents:0,responsibility_source:'self_pay'},balance_cents:0}),
  visitSummary({state:'patient_owes',waiting_on:'patient',account:{id:'account',status:'posted',version:8},insurance:{insured:true,status:'answered',paid_cents:20000,pending_cents:0,unassigned_cents:0},patient:{copay_cents:null,received_cents:0,receipts_applied_cents:0,owes_now_cents:3000,responsibility_source:'insurer_response'},balance_cents:3000,claim:{id:'claim',status:'adjudicated'}}),
 ]){
  ctx.activeVisit={id:'visit',appointment_id:'appointment',status:'signed',version:3};
  await openCharges(summary);
  assert.equal(nextLine(),null,`${summary.state}: an encounter with no charge step left is given nothing to press`);
  assert.doesNotMatch(nodes['encounter-billing-editor'].innerHTML,/data-charge-next/,'and no empty place for one is left under the lines');
 }
 // A table opened for something the billing step knows nothing about keeps quiet too.
 ctx.chartSection='billing';ctx.activeVisit=null;
 vm.runInContext('accountEditor()',ctx);
 assert.equal(nextLine(),null,'a charge form outside an open visit promises no next step');
 ctx.chartSection='visits';

 // ---- 5. the line is plain words and follows the encounter ----------------------------------
 ctx.activeVisit={id:'visit',appointment_id:'appointment',status:'in_progress',version:3};
 ctx.workspace.visits=[{id:'visit',appointment_id:'appointment',status:'in_progress'}];
 await openCharges(unsigned);
 const words=nodes['encounter-billing-editor'].innerHTML.slice(nodes['encounter-billing-editor'].innerHTML.indexOf('data-charge-next')).replace(/<[^>]*>/g,' ');
 assert.doesNotMatch(words,/catalog|snapshot|payload|endpoint|schema|account id|draft|version/i,'the line says nothing developer-flavoured');
 // The state moves: the same table is told the note is signed, and the line changes with it.
 // A payer with no insurer ID is billed outside SunCharts, so the encounter's own post is the step:
 // the same table, the same card, with nothing to send electronically.
 ctx.activeVisit={id:'visit',appointment_id:'appointment',status:'signed',version:3};
 ctx.workspace.visits=[{id:'visit',appointment_id:'appointment',status:'signed'}];
 const postPlain={...post,insurance:{...post.insurance,electronic:false}};
 stepFor(postPlain,ctx.workspace.billing.accounts[0].version);
 vm.runInContext('paintEncounterRevenue(encounterRevenueState,()=>true)',ctx);
 await enterTable();
 await settle();
 assert.equal(nextLine().label,'Post charges','the line follows the encounter\u2019s own state');
 assert.match($('encounter-revenue-status').innerHTML,/Post charges/,'and the card moved with it');
 console.log('PASS charge table footer: one next step under the table, the same step the card gives, the send handed to the review panel, nothing for a state with no charge step, and plain words');
})().catch(error=>{console.error(error);process.exitCode=1;});
