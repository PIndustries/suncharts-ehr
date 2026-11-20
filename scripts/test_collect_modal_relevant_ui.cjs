// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic DOM fixtures for the Collect payment window; no jsdom, no real patient data.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// A small DOM: every node answers the handful of calls the payment window makes.
function node(tag,attrs={}){
 const n={tagName:tag,innerHTML:'',dataset:{},hidden:false,isConnected:true,attrs:{...attrs},style:{},children:[],parentNode:null,
  classList:{classes:new Set(),toggle(c,on){on?this.classes.add(c):this.classes.delete(c);},add(c){this.classes.add(c);},contains(c){return this.classes.has(c);}},
  listeners:{},addEventListener(t,fn,o){(this.listeners[t]??=[]).push({fn,o});},
  setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k]??null;},
  setAttributeNS(_ns,k,v){this.attrs[k.replace(/^html:/,'')]=String(v);},
  focus(){},scrollIntoView(){},remove(){},replaceChildren(){this.innerHTML='';},
  hasAttribute(k){return k in this.dataset||k in this.attrs;},
  insertAdjacentHTML(_pos,html){this.innerHTML+=html;},
  matches(sel){return Object.entries(attrs).every(([k,v])=>this.getAttribute(k)===v);},
  querySelector(sel){return n.querySelectorAll(sel)[0]||null;},
  querySelectorAll(sel){
   const out=[];
   const walk=item=>{for(const child of item.children){
    if(sel==='[data-collect-method]'&&'collectMethod' in child.dataset)out.push(child);
    else if(sel==='[data-collect-holder]'&&'collectHolder' in child.dataset)out.push(child);
    else if(sel==='[data-collect-progress]'&&'collectProgress' in child.dataset)out.push(child);
    else if(sel==='[name="amount"]'&&child.attrs.name==='amount')out.push(child);
    else if(sel==='[data-reader-payment="waiting"],[data-reader-payment="finishing"]'&&child.dataset.readerPayment)out.push(child);
    else if(sel==='h3'&&child.matches('h3'))out.push(child);
    else if(sel==='[name="collect_target"]'&&child.attrs.dataCollectTarget==='')out.push(child);
    walk(child);
   }};
   walk(n);return out;
  },
  append(child){child.parentNode=this;this.children.push(child);},
  prepend(child){child.parentNode=this;this.children.unshift(child);},
  insertBefore(child,before){child.parentNode=this;const at=this.children.indexOf(before);this.children.splice(at<0?this.children.length:at,0,child);},
  removeChild(child){const at=this.children.indexOf(child);if(at>=0)this.children.splice(at,1);child.parentNode=null;}};
 return n;
}

// The window's own head: the tabs and the empty panel the chosen method is drawn into.
function collectHead(){
 const head=node('div');head.dataset.collectHead='';
 const tabs=node('nav'),holder=node('div');holder.dataset.collectHolder='';
 head.children.push(tabs,holder);
 head.querySelector=sel=>[...head.children].find(ch=>sel==='[data-collect-holder]'?'collectHolder' in ch.dataset:sel==='[data-collect-progress]'?'collectProgress' in ch.dataset:'collectOwed' in ch.dataset)||null;
 head.querySelectorAll=sel=>[...head.children].filter(ch=>sel==='[data-collect-method]'?'collectMethod' in ch.dataset:'collectHolder' in ch.dataset);
 return head;
}

function realHead(dialog){const heading=dialog.querySelector('h3');return heading?heading.badges:'';}
function realQuery(root,sel){
 const out=[];
 const walk=item=>{for(const child of item.children){
  if(sel==='[data-collect-holder]'&&'collectHolder' in child.dataset)out.push(child);
  walk(child);
 }};
 walk(root);return out[0]||null;
}

function fixture({copay_cents=2500,copay_due_cents=0,copay_paid_cents=2500,owes_now_cents=0}={}){
 const nodes={},handlers={},opened=[],calls=[];
 const appointment={id:'appt',patient_id:'patient',status:'checked_in',title:'Synthetic visit',starts_at:'2026-11-11T14:00:00Z',timezone:'UTC'};
 const ctx={console,Date,Intl,URL,Math,encodeURIComponent,
  crypto:{randomUUID:()=>'stable-request'},
  me:{role:'owner'},selected:'patient',chartSection:'visits',encounterSection:'charges',activeVisit:{id:'visit',appointment_id:'appt',status:'posted',version:1},
  workspace:{patient:{id:'patient'},appointments:[appointment],visits:[{id:'visit',appointment_id:'appt'}],billing:{accounts:[{id:'account',status:copay_due_cents>0?'draft':'posted',version:1,content:{visit_id:'visit',lines:[]}}],entries:[],copays:[],coverages:[{id:'coverage',content:{priority:'primary',status:'active',effective_date:'2026-01-01',copay_cents}}]}},
  encounterRevenueState:{patient:'patient',visit:'visit',account:'account',data:{summary:{patient:{copay_cents,copay_due_cents,copay_paid_cents,owes_now_cents,unapplied_cents:0},receipts:[],insurance:{insured:false},charges_cents:15000}}},
  encounterChargeAccount:()=>ctx.workspace.billing.accounts[0],
  localStorage:{store:{},getItem(k){return this.store[k]??null;},setItem(k,v){this.store[k]=String(v);}},
  document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),createComment:t=>({textContent:t,parentNode:null}),createElement:tag=>tag==='div'?collectHead():node(tag),querySelector:()=>null,body:node('body')},
  $:id=>nodes[id]??null,esc,date:String,human:String,displayStatus:String,
  money:n=>`$${(n/100).toFixed(2)}`,dollars:n=>(n/100).toFixed(2),cents:s=>Math.round(Number(s)*100),
  billingCan:()=>true,invoicePaymentMethod:String,encounterNumberText:()=>'ENC-0007',
  notice:(m,e)=>ctx.noticeShown.push(m),run:fn=>{ctx.pending=Promise.resolve().then(fn);return ctx.pending;},
  loadEncounterRevenueStatus:async()=>{},selectPatient:async()=>{},showChartSection:()=>{},paintHostedCopayState(){},noticeShown:[],
  readersForPayment:async()=>[{id:'reader-1',name:'Front desk reader',online:true}],
  savedCardsForCharge:async()=>({cards:[{brand:'Visa',last4:'4242',setup_id:'set-1',charge_later:true}],inPerson:0}),
  readerChoiceMarkup:readers=>`<input type="hidden" name="reader" value="${readers[0].id}">`,
  savedCardChoiceMarkup:found=>`<input type="hidden" name="card" value="${found.cards[0].setup_id}">`,
  stopReaderPayment(){},flashUpdated(){},
  sheetOpen(title,panel){const dialog=node('dialog');dialog.title=title;
   dialog.innerHTML=`<header class="sheet-head"><h3>${esc(title)}</h3></header>`;
   const heading=node('h3',{h3:''});heading.textContent=title;heading.badges='';heading.insertAdjacentHTML=(pos,html)=>{heading.badges+=html;};
   dialog.querySelector=sel=>sel==='h3'||sel==='.sheet-head h3'?heading:realQuery(dialog,sel);
   dialog.children.push(panel);panel.parentNode=dialog;opened.push(dialog);return dialog;},
  testPaymentLabel:()=>'Test payment',
  api:async(...args)=>{calls.push(args);return {items:[],availability:{available:true,livemode:false,reason:null}};}};
 ctx.sheetWide=true;
 vm.createContext(ctx);
 vm.runInContext(fs.readFileSync(path.join(root,'web/patient-revenue.js'),'utf8'),ctx);
 // The test realm's numbers are not the script realm's, so a copy of the summary written inside
 // the script's own realm is what the payment window reads.
 vm.runInContext('encounterRevenueState={patient:selected,identity:me,visit:"visit",account:"account",version:1,data:{summary:'+JSON.stringify(ctx.encounterRevenueState.data)+'}};this.encounterRevenueState=encounterRevenueState;',ctx);
 nodes['visit-billing-collect']=node('section');nodes['visit-billing-host']=node('div');nodes['visit-billing-host'].children.push(nodes['visit-billing-collect']);nodes['visit-billing-collect'].parentNode=nodes['visit-billing-host'];
 nodes['encounter-hosted-copay']=node('section');nodes['encounter-hosted-copay'].dataset.appointment='appt';
 nodes['encounter-hosted-copay-reader']=node('div');
 nodes['insurance-hosted-copay-reader']=node('div');
 const f={ctx,handlers,nodes,opened,calls,
  panel(){return opened[0].querySelector('[data-collect-holder]');},
  click(tab){const event={preventDefault(){},target:{closest:sel=>sel==='[data-collect-method]'?tab:null}};for(const h of handlers.click||[])h(event);if(!opened.length)this.openCollectModal();return Promise.resolve(ctx.pending).then(()=>f);},
  openCollectModal(){const done=ctx.openCollectModal();return opened.length?opened[0]:done;},
  summary(){return ctx.encounterRevenueState.data.summary;},
  account(){return ctx.workspace.billing.accounts[0];},
  setCopay({copay_cents=2500,copay_due_cents=0,copay_paid_cents=copay_cents-copay_due_cents,owes_now_cents=copay_due_cents}={}){
   // The window reads its summary from the script's own realm, so the copy is written in there.
   vm.runInContext('encounterRevenueState.data.summary.patient='+JSON.stringify({copay_cents,copay_due_cents,copay_paid_cents,owes_now_cents,unapplied_cents:0})+
    ';encounterRevenueState.data.summary.state='+(copay_due_cents>0?'"collect_copay"':'"prepare_claim"')+';workspace.billing.coverages[0].content.copay_cents='+copay_cents+
    ';workspace.billing.accounts[0].status='+(copay_due_cents>0?'"draft"':'"posted"')+';',ctx);
   return f;
  },
  async use(key,state){
   if(state)f.setCopay(state);
   f.openCollectModal();
   for(let i=0;i<12;i++)await Promise.resolve(ctx.pending);
   await f.click({dataset:{collectMethod:key}});
   for(let i=0;i<12;i++)await Promise.resolve(ctx.pending);
   if(ctx.noticeShown.length)throw new Error('notice: '+ctx.noticeShown.join('; '));
   return f;
  }};
 return f;
}

(async()=>{
 // 1. The window opens with no method panel at all, even with the copay already Paid and $0.00 owed.
 let f=fixture(),c=f.ctx;
 assert.equal(c.openCollectModal(),true);
 const dialog=f.opened[0];
 const holder=dialog.querySelector('[data-collect-holder]');
 assert.ok(holder,'the window has a panel that holds the chosen method');
 assert.equal(holder.innerHTML,'','no method panel is drawn before a tab is pressed');
 assert.equal(f.nodes['encounter-hosted-copay-reader'].innerHTML,'','the card copay panel is not drawn into the encounter either');
 assert.equal(dialog.dataset.method,undefined,'no method tab is selected when the window opens');
 assert.ok(!holder.innerHTML.includes('Prepare secure card checkout'));
 // Pressing a tab is what draws that method's panel.
 const linkTab={dataset:{collectMethod:'link'}};await f.click(linkTab);
 assert.match(holder.innerHTML,/id="hosted-copay-form"/);
 assert.match(holder.innerHTML,/Prepare secure card checkout/);
 assert.equal(dialog.dataset.method,'link');

 // 2. The card panels label the amount by what is being taken, not by habit.
 // Reader, copay already paid: plain amount.
 f=await fixture().use('reader');
 let holderOf=f.panel();
 assert.match(holderOf.innerHTML,/id="reader-copay-form"/);
 assert.match(holderOf.innerHTML,/<label>Amount \(USD\)<input name="amount"/);
 assert.doesNotMatch(holderOf.innerHTML,/Copay amount \(USD\)/);
 // Reader, copay unpaid and fully owed: it is the copay being taken.
 f=await fixture().use('reader',{copay_cents:2500,copay_due_cents:2500,copay_paid_cents:0,owes_now_cents:2500});
 holderOf=f.panel();
 assert.match(holderOf.innerHTML,/<label>Copay amount \(USD\)<input name="amount"/,JSON.stringify(f.lastLabel));
 // Card on file, copay already paid: plain amount.
 f=await fixture().use('saved');
 holderOf=f.panel();
 assert.match(holderOf.innerHTML,/id="saved-card-copay-form"/);
 assert.match(holderOf.innerHTML,/<label>Amount \(USD\)<input name="amount"/);
 assert.doesNotMatch(holderOf.innerHTML,/Copay amount \(USD\)/);
 // Card on file, copay unpaid: copay label.
 f=await fixture().use('saved',{copay_cents:2500,copay_due_cents:2500,copay_paid_cents:0,owes_now_cents:2500});
 holderOf=f.panel();
 assert.match(holderOf.innerHTML,/<label>Copay amount \(USD\)<input name="amount"/);
 // Payment link, copay already paid: plain amount.
 f=await fixture().use('link');
 holderOf=f.panel();
 assert.match(holderOf.innerHTML,/<label>Amount \(USD\)<input name="amount"/);
 assert.doesNotMatch(holderOf.innerHTML,/Copay amount \(USD\)/);
 // Payment link, copay unpaid: copay label.
 f=await fixture().use('link',{copay_cents:2500,copay_due_cents:2500,copay_paid_cents:0,owes_now_cents:2500});
 holderOf=f.panel();
 assert.match(holderOf.innerHTML,/<label>Copay amount \(USD\)<input name="amount"/);
 // Outside the window the Insurance tab keeps asking for a copay amount as before.
 f=fixture();f.setCopay({copay_cents:2500,copay_due_cents:2500,copay_paid_cents:0,owes_now_cents:2500});await f.ctx.openReaderCopayEditor('appt','insurance-hosted-copay');
 assert.match(f.nodes['insurance-hosted-copay-reader'].innerHTML,/<label>Copay amount \(USD\)<input name="amount"/);
 console.log('PASS the Collect payment window waits for a tab, and labels the amount by what is taken');

 // 3. Test mode is a small badge beside the window title, never a line of its own.
 f=fixture();c=f.ctx;c.openCollectModal();
 const titleBadge=realHead(f.opened[0])||'';
 assert.match(titleBadge,/<span class="status-badge test-badge collect-test-badge">Test mode<\/span>/);
 assert.doesNotMatch(titleBadge,/Test payment/,'the badge says Test mode in staff wording');
 // The payments list keeps no lone test line any more.
 const state=c.hostedCopayStateFor('appt');
 state.availability={available:true,livemode:false,reason:null};
 state.items=[{id:'op',patient_id:'patient',appointment_id:'appt',amount_cents:2500,currency:'usd',livemode:false,status:'paid',receipt_id:'receipt',created_at:'2026-11-11T14:00:00Z'}];
 const panelMarkup=c.encounterHostedCopayMarkup(state);
 assert.doesNotMatch(panelMarkup,/copay-mode-label|<p class="copay-mode-label">Test payment/);
 assert.doesNotMatch(panelMarkup,/Collect card copay · Test payment/,'the card link panel carries no test line of its own');
 // A production build shows no badge at all.
 f=fixture();f.ctx.testPaymentLabel=()=>'';f.ctx.openCollectModal();
 assert.equal(realHead(f.opened[0]),'');
 console.log('PASS test mode shows as a badge beside the window title, not as a line above the payments');

 // The CSS keeps the window honest: no holder shows before a method is chosen.
 const css=fs.readFileSync(path.join(root,'web/visit-billing.css'),'utf8');
 assert.match(css,/\.collect-sheet:not\(\[data-method\]\) \.collect-methods\+\[data-collect-holder\]\{display:none\}/);
 console.log('PASS the window hides the method panel until a tab is pressed');
})().catch(error=>{console.error(error);process.exitCode=1;});
