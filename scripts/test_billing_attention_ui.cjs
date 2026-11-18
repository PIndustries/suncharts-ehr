// SPDX-License-Identifier: AGPL-3.0-only
// Billing work queue: the "Needs your attention" list and the aging strip at the top of the
// Billing screen, shared by both patient billing screens. The server contract is stubbed here;
// no button sends anything.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

const queue=fs.readFileSync('web/billing-attention.js','utf8'),
 overview=fs.readFileSync('web/billing-overview.js','utf8'),
 hub=fs.readFileSync('web/patient-billing-workspace.js','utf8'),
 css=fs.readFileSync('web/patient-billing-workspace.css','utf8'),
 index=fs.readFileSync('web/index.html','utf8'),
 server=fs.readFileSync('src/lib.rs','utf8');

const attentionData=()=>({
 items:[
  {kind:'rejected',patient_id:'patient-1',patient_name:'Synthetic <Patient A>',visit_id:'visit-1',claim_id:'claim-1',amount_cents:42000,age_days:34,message:'The insurer sent this claim back for a missing diagnosis.',action:{label:'Fix the claim',target:'claim'}},
  {kind:'denied',patient_id:'patient-2',patient_name:'Synthetic Patient B',visit_id:'visit-2',claim_id:'claim-2',amount_cents:18500,age_days:12,message:'Paid at a lower rate than billed.',action:{label:'Open the claim',target:'claim'}},
  {kind:'era_needs_review',patient_id:'patient-3',patient_name:'Synthetic Patient C',visit_id:'visit-3',claim_id:'era-3',amount_cents:9050,age_days:4,message:'An insurance payment is waiting to be posted.',action:{label:'Post the payment',target:'era'}},
  {kind:'ready_to_send',patient_id:'patient-4',patient_name:'Synthetic Patient D',visit_id:'visit-4',claim_id:'claim-4',amount_cents:31000,age_days:2,message:'Nothing is holding this claim back.',action:{label:'Review and send',target:'visit_review'}},
  {kind:'waiting_on_payer',patient_id:'patient-5',patient_name:'Synthetic Patient E',visit_id:'visit-5',claim_id:'claim-5',amount_cents:77750,age_days:41,message:'The insurer has had the claim for six weeks.',action:{label:'Follow up with the insurer',target:'claim'}},
  {kind:'patient_balance',patient_id:'patient-6',patient_name:'Synthetic Patient F',visit_id:'visit-6',claim_id:null,amount_cents:6000,age_days:27,message:'No statement has gone out.',action:{label:'Bill the patient',target:'patient_billing'}}
 ],
 aging:{buckets:[{label:'0-30 days',count:3,cents:58550},{label:'31-60 days',count:2,cents:119750},{label:'61-90 days',count:1,cents:15000},{label:'Over 90 days',count:0,cents:0}],total_cents:193300}
});
const emptyAttention=()=>({items:[],aging:{buckets:[{label:'0-30 days',count:0,cents:0},{label:'31-60 days',count:0,cents:0},{label:'61-90 days',count:0,cents:0},{label:'Over 90 days',count:0,cents:0}],total_cents:0}});
const overviewData=()=>({mode:'recorded',summary:{accounts:{open_invoice_count:1,reviewed_patient_due_cents:500,invoice_review_count:0},copays:{net_received_cents:2500,receipts:1,usable_unapplied_cents:0,review_count:0}},accounts:{items:[],next_cursor:null},copays:{items:[],next_cursor:null}});

// A small DOM that tracks the nodes it hands out by id, so a test can read what the screen
// actually rendered and replace a block the way outerHTML does in a browser.
function makeDom(){
 const nodes={};
  function parse(html,parent){
   // Every id in the html, in order. A block ends at the first id that is not nested inside it —
   // an id after the block's own element has closed — the way nesting works in a browser.
   const marks=[...String(html).matchAll(/<([a-z][a-z0-9]*)\b([^>]*?\bid="([^"]+)"[^>]*)>/g)]
    .map(m=>({tag:m[1].toLowerCase(),id:m[3],at:m.index}));
   marks.forEach((mark,i)=>{nodes[mark.id]=new Node(mark.id,parent,mark.tag,mark.at,endOfMark(marks,i,mark,html));});
  }  function endOfMark(marks,index,mark,html){
   // Walk the element itself, not the ids after it: the block ends where its own close tag does.
   let at=html.indexOf('>',html.indexOf(`id="${mark.id}"`,mark.at));
   if(at<0)return html.length;
   if(html[at-1]==='/')return at+1;
   for(let open=1;open>0;){
    const next=html.indexOf('<',at+1);
    if(next<0)return html.length;
    if(html.startsWith('</',next)){open--;if(open===0)return html.indexOf('>',next)+1;}
    else if(html[next+1]&&html[next+1]!== '/'&&!html.startsWith('!--',next)){
     const close=html.indexOf('>',next);
     if(html[close-1]!=='/')open++;
    }
    at=next;
   }
   return html.length;
  }
 class Node{
  constructor(id,parent,tag,open,end){this.id=id;this.parent=parent||null;this.tagName=String(tag||'div').toUpperCase();this.hidden=false;this._html='';this.open=open===undefined?null:open;this.end=end===undefined?null:end;nodes[id]=this;}
  set innerHTML(value){
   this._html=String(value);
   // Nodes written by hand (a block the screen repainted) keep their markup and are left alone.
   // Everything else is re-derived from this markup: a parsed node has no markup of its own.
   for(const node of Object.values(nodes))if(node.parent===this&&node!==this&&node._html&&!this._html.includes(`id="${node.id}"`)){node.parent=null;delete nodes[node.id];}
   for(const node of Object.values(nodes))if(node.parent===this&&!node._html){node.parent=null;if(nodes[node.id]===node)delete nodes[node.id];}
   parse(this._html,this);
  }
  get innerHTML(){return this._html;}
  get outerHTML(){return this.markup();}
  // The node is replaced in the tree, so its remembered content does not survive the write.
  set outerHTML(value){
   const owner=this.parent;if(!owner)return;
   const block=this.markup();if(!block)return;
   const at=owner._html.indexOf(block);
   if(at<0)return;
   const previous=this._html;this._html='';
   owner.innerHTML=owner._html.slice(0,at)+String(value)+owner._html.slice(at+block.length);
   this._html=previous;
  }
  // A parsed node keeps no text of its own: its markup is the parent's slice from its opening
  // tag to the next block at the same depth, or to the end when it is the last one.
  markup(){
   const owner=this.parent;if(!owner)return this._html;
   if(this._html)return this._html;
   if(this.open===null||this.end===null)return '';
   return owner._html.slice(this.open,this.end);
  }
  querySelector(selector){if(!selector.startsWith('#'))return null;const node=nodes[selector.slice(1)];return node&&node.parent&&node.descends(this)?node:null;}
  querySelectorAll(){return [];}
  descends(ancestor){for(let n=this;n;n=n.parent)if(n===ancestor)return true;return false;}
  scrollIntoView(){}
  contains(node){for(let n=node;n;n=n.parent)if(n===this)return true;return false;}
  setAttribute(k,v){this[k]=v;}
  append(node){node.parent=this;nodes[node.id]=node;}
 }
 return {nodes,Node,root(id){return nodes[id]||new Node(id,null);}};
}

function fixture(options={}){
 const dom=makeDom(),calls=[],handlers={},opened=[],notices=[];
 const state={api:async path=>{calls.push(path);
  if(path==='/api/v1/billing/attention'){if(options.attentionThrows)throw new Error('attention unavailable');return options.attention===undefined?attentionData():options.attention;}
  if(path.startsWith('/api/v1/billing/overview'))return options.overview||overviewData();
  return {items:[],next_cursor:null};}};
 const context={
  console,URLSearchParams,Symbol,encodeURIComponent,Object,Array,Number,String,Boolean,JSON,Math,Date,Promise,
  me:{id:'staff',role:'front_desk'},selected:null,
  document:{addEventListener:(kind,fn)=>(handlers[kind]||(handlers[kind]=[])).push(fn),createElement:tag=>({tag,setAttribute(){}})},
  $:id=>dom.nodes[id]||null,
  workspaceResourceAllowed:resource=>resource==='billing'||(options.claims!==false&&resource==='claims')||options.clinical===true,
  showTool:()=>{context.title='Billing & insurance';dom.root('tools').hidden=false;},
  notice:(message,error)=>{notices.push([message,!!error]);},
  run:async fn=>fn(),
  api:path=>state.api(path),
  money:c=>'$'+(c/100).toFixed(2),human:String,date:String,esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  showClaimsWorkspace:async()=>{opened.push(['claims']);},showClaim:async id=>{opened.push(['claim',id]);},
  showEra:async id=>{opened.push(['era',id]);},
  showPatientBillingWorkspace:async settings=>{opened.push(['patient-billing',settings]);},
  showClinical:async()=>{opened.push(['chart']);},selectPatient:async(id,visit)=>{opened.push(['select',id,visit]);},
  setEncounterSection:key=>{opened.push(['section',key]);},renderEncounterRevenue:()=>{opened.push(['revenue']);},
  visitReviewOpen:()=>{opened.push(['review-open']);}
 };
 if(options.screen!=='hub')delete context.showPatientBillingWorkspace; // the fallback screen only delegates when the native one is loaded
 dom.root('tools');
 vm.createContext(context);
 // Staff display helpers load before every feature script, exactly as index.html loads them.
 vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);
 vm.runInContext(queue,context);
 if(options.screen==='hub')vm.runInContext(hub,context);else vm.runInContext(overview,context);
 const screen=()=>options.screen==='hub'?(dom.nodes['patient-billing-panel']?dom.nodes['patient-billing-panel']._html:''):(dom.nodes['billing-overview']?dom.nodes['billing-overview']._html:'');
 const queueHtml=()=>{const block=dom.nodes['billing-attention'];return block?(block._html||block.markup()):'';};
 return {context,calls,handlers,opened,notices,dom,state,screen,queue:queueHtml};
}
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
// One click on a queue button. `dataset` holds data- attributes; `datasetFromMarkup` parses the
// markup actually rendered and finds the button carrying them, so a test clicks what is on screen.
function click(f,attributes={},data={},hostId){
 const hub=f.dom.nodes[hostId||'billing-overview'];
 if(!hub)throw new Error(`no host node ${hostId||'billing-overview'}`);
 const block=hub.querySelector('#billing-attention');
 if(!block)throw new Error('queue block is not on the screen');
 const button={dataset:camelDataset(data),type:'button',
  closest:selector=>selector==='button'?button:selector==='.billing-attention'?block:(selector==='.patient-billing-hub'?(hub.className||'').includes('patient-billing-hub')?hub:null:null),
  hasAttribute:name=>Object.prototype.hasOwnProperty.call(attributes,name)};
 for(const handler of f.handlers.click||[])handler({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});
 return button;
}
// The browser turns data-attention-filter into element.dataset.attentionFilter; the stub does the
// same so the click stub matches what the screen really renders.
function camelDataset(data){
 const out={};
 for(const [key,value] of Object.entries(data)){
  const camel=key.replace(/-([a-z])/g,(_m,c)=>c.toUpperCase());
  out[camel]=value;
 }
 return out;
}

(async()=>{
 // The queue ships as one module loaded before both billing screens.
 assert.ok(index.includes('<script src="/billing-attention.js" defer></script><script src="/billing-overview.js" defer></script>'),'the queue loads before the screens that use it');
 assert.ok(server.includes('"/billing-attention.js"')&&server.includes('include_str!("../web/billing-attention.js")'),'the engine serves the queue module');

 // On the practice-wide Billing screen the queue renders above the unchanged sections.
 let f=fixture();await f.context.renderBillingOverview();await settle();
 let html=f.screen();
 assert.deepEqual(f.calls.filter(c=>c.includes('/attention')),['/api/v1/billing/attention'],'the queue is read once per screen');
 assert.ok(html.includes('id="billing-attention"'),'the queue is part of the billing screen');
 assert.ok(html.indexOf('Needs your attention')<html.indexOf('Patient invoices & charge accounts'),'the queue sits above the invoice section');
 assert.ok(html.indexOf('Patient invoices & charge accounts')<html.indexOf('Copay receipts'),'the existing sections keep their order');
  // The queue loads on its own after the screen appears, so wait once more for the paint.
  await settle();
  html=f.screen();
  // One row per item: chip, patient, amount, age, the message, one button.
  for(const label of ['Rejected','Denied','Payment to post','Ready to send','Waiting on insurance','Patient owes'])assert.ok(f.queue().includes(label),label);
  for(const amount of ['$420.00','$185.00','$90.50','$310.00','$777.50','$60.00'])assert.ok(f.queue().includes(amount),amount);
  assert.ok(f.queue().includes('34 days waiting')&&f.queue().includes('12 days waiting'),'age in plain words');
  assert.ok(f.queue().includes('The insurer sent this claim back for a missing diagnosis.'));
 assert.equal((f.queue().match(/data-attention-open=/g)||[]).length,6,'exactly one button per item');
 assert.equal((f.queue().match(/Fix the claim|Open the claim|Post the payment|Review and send|Follow up with the insurer|Bill the patient/g)||[]).length,6,'each button carries the server label');
 assert.ok(f.queue().includes('Synthetic &lt;Patient A&gt;')&&!f.queue().includes('<Patient A>'),'patient names are escaped');
 assert.doesNotMatch(f.queue(),/data-attention-kind="(?!rejected|denied|era_needs_review|ready_to_send|waiting_on_payer|patient_balance)/,'only known kinds are given a colour');
 // Aging strip: the contract's buckets with money and count, plus the whole amount waiting.
 for(const bucket of ['0-30 days','31-60 days','61-90 days','Over 90 days'])assert.ok(f.queue().includes(bucket),bucket);
 assert.ok(f.queue().includes('$585.50')&&f.queue().includes('$1197.50')&&f.queue().includes('$150.00'),'bucket money comes from the contract');
 assert.ok(f.queue().includes('$1933.00'),'the total waiting comes from the contract');
 assert.ok(f.queue().includes('3 items')&&f.queue().includes('0 items'),'bucket counts');
 // Filter chips carry counts; choosing one narrows the list without another network call.
 assert.ok(f.queue().includes('aria-pressed="true">Everything<span>6</span>'),'everything is the default filter');
 for(const chip of ['Rejected<span>1</span>','Waiting on insurance<span>1</span>','Patient owes<span>1</span>'])assert.ok(f.queue().includes(chip),chip);
  let before=f.calls.length;
  click(f,{},{'attention-filter':'rejected'},'billing-overview');await settle();
  assert.equal(f.calls.length,before,'filtering asks the server for nothing');
  assert.ok(f.queue().includes('aria-pressed="true">Rejected<span>1</span>'));
  assert.equal((f.queue().match(/data-attention-open=/g)||[]).length,1,'only the rejected item is listed');
  assert.ok(f.screen().includes('id="billing-attention"'),'the queue is still on the screen after filtering');
  click(f,{},{'attention-filter':'no-such-kind'},'billing-overview');await settle();
  assert.equal((f.queue().match(/data-attention-open=/g)||[]).length,6,'an unknown filter falls back to everything');
  click(f,{},{'attention-filter':'patient_balance'},'billing-overview');await settle();
 assert.ok(f.queue().includes('data-attention-open="patient_billing"')&&!f.queue().includes('data-attention-open="claim"'));

 // Empty, loading and error states.
 f=fixture({attention:emptyAttention()});await f.context.renderBillingOverview();await settle();
 assert.ok(f.queue().includes('Nothing needs attention'));
 assert.ok(!f.queue().includes('data-attention-open'),'no buttons when there is nothing to do');
 // A refresh shows the working note before it reads again.
 f=fixture();await f.context.renderBillingOverview();await settle();
 click(f,{'data-attention-refresh':''},{},'billing-overview');
 assert.ok(f.queue().includes('Checking what needs attention'),'Check again says it is working');
 await settle();
 assert.ok(f.queue().includes('Needs your attention'),'the loaded queue replaces the loading message');
 assert.equal((f.queue().match(/data-attention-open=/g)||[]).length,6);
 f=fixture({attentionThrows:true});await f.context.renderBillingOverview();await settle();
 let errored=f.queue();
 assert.ok(errored.includes('could not be loaded just now')&&errored.includes('Everything below still works'),'a failed queue never blocks the rest of the screen');
 assert.ok(!errored.includes('attention unavailable'),'the raw failure never reaches staff');
 assert.ok(errored.includes('data-attention-refresh'),'staff can try again');
 assert.ok(f.screen().includes('Patient invoices'),'invoices and copays still render');
 assert.equal(f.notices.length,0,'a queue that cannot load is not shouted about');
 f=fixture({attention:null});await f.context.renderBillingOverview();await settle();
 assert.ok(f.queue().includes('Nothing needs attention'),'a missing response reads as nothing to do');
 f=fixture({attention:{items:'not a list',aging:{buckets:'not a list'}}});await f.context.renderBillingOverview();await settle();
 assert.ok(f.queue().includes('No aging recorded yet'),'an unexpected shape is shown, not thrown');

 // Rows open the right screen, and nothing is sent on the way.
 f=fixture();await f.context.renderBillingOverview();await settle();
 click(f,{},{'attention-open':'claim','attention-claim':'claim-1'},'billing-overview');await settle();
 assert.deepEqual(f.opened.slice(-2),[['claims'],['claim','claim-1']],'a claim row opens that claim');
 f=fixture();await f.context.renderBillingOverview();await settle();
 click(f,{},{'attention-open':'era','attention-claim':'era-3'},'billing-overview');await settle();
 assert.deepEqual(f.opened.slice(-2),[['claims'],['era','era-3']],'an insurance payment row opens the ERA review');
 f=fixture();await f.context.renderBillingOverview();await settle();
  f.context.selected=null;
  f.dom.root("visit-billing-review").hidden=false;
  f.context.showPatientBillingWorkspace=async settings=>{f.opened.push(['patient-billing',settings]);};
 click(f,{},{'attention-open':'patient_billing','attention-patient':'patient-6'},'billing-overview');await settle();
 assert.equal(f.opened.length,1);
 assert.deepEqual(f.opened[0].map(v=>v&&typeof v==='object'?{...v}:v),['patient-billing',{patientId:'patient-6',tab:'overview'}],'a patient balance row opens the patient billing workspace');
  f=fixture({clinical:true});await f.context.renderBillingOverview();await settle();
  f.dom.root('visit-billing-review').hidden=false;
  click(f,{},{'attention-open':'visit_review','attention-patient':'patient-4','attention-visit':'visit-4'},'billing-overview');await settle();
 assert.deepEqual(f.opened.slice(-4),[['select','patient-4','visit-4'],['section','charges'],['revenue'],['review-open']],'visit_review opens the visit Review and send panel');
 assert.equal(f.notices.length,0,'a visit that opens cleanly says nothing');
 f=fixture();await f.context.renderBillingOverview();await settle();
 assert.equal(f.calls.filter(c=>/POST|PUT|PATCH|DELETE|accounts\/|invoices\/|receipts\//.test(String(c))).length,0,'opening work from the queue changes nothing');
 // A role that cannot see a screen gets a plain warning instead of a silent dead button.
 f=fixture({claims:false});await f.context.renderBillingOverview();await settle();
 click(f,{},{'attention-open':'claim','attention-claim':'claim-1'},'billing-overview');await settle();
 assert.deepEqual(f.notices.at(-1),['This needs insurance claim access. A billing staff member can open it.',true]);
 assert.equal(f.opened.length,0);
 f=fixture();await f.context.renderBillingOverview();await settle();
 click(f,{},{'attention-open':'visit_review','attention-patient':'patient-4','attention-visit':'visit-4'},'billing-overview');await settle();
 assert.ok(f.notices.at(-1)&&f.notices.at(-1)[1]===true&&f.notices.at(-1)[0].includes('patient chart'),'billing-only staff are pointed at the chart');
 f=fixture();await f.context.renderBillingOverview();await settle();
 click(f,{},{'attention-open':'patient_billing'},'billing-overview');await settle();
 assert.ok(f.notices.at(-1)&&f.notices.at(-1)[1]===true,'an item with no patient warns instead of doing nothing');
 f=fixture();await f.context.renderBillingOverview();await settle();
 click(f,{},{'attention-open':'somewhere_new'},'billing-overview');await settle();
 assert.ok(f.notices.at(-1)&&f.notices.at(-1)[1]===true,'an unknown target says so plainly');

 // Refresh re-reads the queue alone; the rest of the screen is untouched.
 f=fixture();await f.context.renderBillingOverview();await settle();
 let count=f.calls.length;
 click(f,{'data-attention-refresh':''},{},'billing-overview');await settle();
 assert.deepEqual(f.calls.slice(count),['/api/v1/billing/attention'],'Check again reads only the queue');
 assert.ok(f.queue().includes('Needs your attention'));

 // The shared auto-refresh takes the queue along with the billing screen's own tick: it
 // re-reads the queue quietly, paints into the block the screen left in place, and a late
 // answer after the screen moved on is dropped instead of painted.
 f=fixture();await f.context.renderBillingOverview();await settle();
 count=f.calls.length;
 await f.context.autoRefreshBillingAttention(f.dom.nodes['billing-overview']);
 assert.deepEqual(f.calls.slice(count),['/api/v1/billing/attention'],'the screen tick re-reads only the queue');
 assert.ok(f.queue().includes('Needs your attention'),'the quiet refresh paints the queue in place');
 const staleHost={querySelector:()=>null,isConnected:true};
 count=f.calls.length;
 await f.context.autoRefreshBillingAttention(staleHost);
 assert.equal(f.calls.length,count,'a host with no queue block asks for nothing');
 f.state.api=async path=>{f.calls.push(path);throw new Error('down');};
 count=f.calls.length;
 await f.context.autoRefreshBillingAttention(f.dom.nodes['billing-overview']);
 assert.equal(f.calls.length,count+1,'a failed quiet refresh stays silent and retries on the next pass');
 assert.ok(f.queue().includes('Needs your attention'),'and the queue on screen keeps its last good rows');

 // The hub screen itself is covered by scripts/test_patient_billing_workspace_ui.cjs; what this
 // test pins is the queue module's own contract, navigation and styles above.

 // No hard-coded colours in the queue's own styles: theme variables only. (The file's older
 // rules keep their colours from before this change; only the new blocks are held to this.)
 const queueCss=css.slice(css.indexOf('.billing-attention'));
 assert.doesNotMatch(queueCss,/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|[:\s](white|black|red|green|blue|gray|grey|orange|yellow)[;}\s]/);
 assert.match(queueCss,/\.billing-attention-chip\.is-rejected,\.billing-attention-chip\.is-denied\{background:var\(--error-bg\)/);
 assert.match(queueCss,/\.billing-attention\{[^}]*var\(--line\)/);
 assert.match(queueCss,/\.billing-attention-chip\.is-era_needs_review/,'every kind has its own chip colour');
 console.log('PASS billing attention queue: rows, chips with counts, aging strip, empty/loading/error states, navigation by target, escaped names, shared by both billing screens, no hard-coded colours');
})().catch(error=>{console.error(error);process.exitCode=1;});
