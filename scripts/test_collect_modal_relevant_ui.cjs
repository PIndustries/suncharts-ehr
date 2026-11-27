// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {JSDOM}=require('jsdom');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'web/patient-revenue.js'),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wait=()=>new Promise(resolve=>setImmediate(resolve));

function fixture({due=6500,draft=false,available=true,operations=[]}={}){
 const dom=new JSDOM('<main><section id="visit-billing-collect" hidden><section id="encounter-hosted-copay" data-appointment="appt"></section><div id="encounter-hosted-copay-reader"></div></section><div id="insurance-hosted-copay-reader"></div></main>',{runScripts:'outside-only',url:'https://synthetic.example/'});
 const w=dom.window,d=w.document,ctx=dom.getInternalVMContext(),calls=[],notices=[];
 const patient={id:'patient',given_name:'Synthetic',family_name:'Patient'};
 const appointment={id:'appt',patient_id:patient.id,status:'checked_in',title:'Synthetic visit',starts_at:'2026-11-11T14:00:00Z',timezone:'UTC'};
 const visit={id:'visit',appointment_id:appointment.id,status:draft?'in_progress':'signed',version:1};
 const account={id:'account',status:draft?'draft':'posted',version:1,content:{visit_id:visit.id,lines:[]}};
 const coverage={id:'coverage',content:{priority:'primary',status:'active',effective_date:'2026-01-01',copay_cents:2500}};
 const summary={patient_id:patient.id,visit,account,patient:{copay_cents:2500,copay_due_cents:draft?due:0,copay_paid_cents:draft?0:2500,owes_now_cents:draft?0:due,unapplied_cents:0},receipts:[],insurance:{insured:true}};
 const find=selector=>d.querySelector(selector);
 w.HTMLElement.prototype.scrollIntoView=function(){};
 Object.assign(ctx,{
  me:{role:'owner'},selected:patient.id,chartSection:'visits',encounterSection:'charges',activeVisit:visit,
  workspace:{patient,appointments:[appointment],visits:[visit],billing:{accounts:[account],entries:[],copays:[],coverages:[coverage]}},
  $:id=>d.getElementById(id),esc,date:String,human:String,displayStatus:String,
  money:n=>`$${(n/100).toFixed(2)}`,dollars:n=>(n/100).toFixed(2),cents:s=>Math.round(Number(s)*100),
  billingCan:()=>true,invoicePaymentMethod:String,encounterNumberText:()=>'ENC-0007',
  notice:message=>notices.push(message),run:action=>{ctx.pending=Promise.resolve().then(action);return ctx.pending;},
  api:async(...args)=>{
   calls.push(args);
   if(args[0].endsWith('/billing/encounters'))return {items:[{appointment_id:'past',owes_now_cents:2500}]};
   return {items:operations,availability:{available,livemode:false}};
  },
  readersForPayment:async()=>[{id:'reader-1',name:'Front desk reader',online:true}],
  savedCardsForCharge:async()=>({cards:[{brand:'Visa',last4:'4242',setup_id:'set-1',charge_later:true}],inPerson:0}),
  readerChoiceMarkup:readers=>`<input type="hidden" name="reader" value="${readers[0].id}">`,
  savedCardChoiceMarkup:found=>`<input type="hidden" name="card" value="${found.cards[0].setup_id}">`,
  stopReaderPayment(){},flashUpdated(){},testPaymentLabel:()=>'Test payment',
  sheetOpen(title,panel){
   const dialog=d.createElement('dialog');dialog.open=true;
   dialog.innerHTML=`<header class="sheet-head"><h3>${esc(title)}</h3></header>`;
   dialog.append(panel);d.body.append(dialog);return dialog;
  },
  sheetClose(dialog){dialog.dispatchEvent(new w.Event('close'));dialog.remove();}
 });
 vm.runInContext(source,ctx);
 vm.runInContext(`encounterRevenueState={patient:selected,identity:me,visit:"visit",account:"account",version:1,data:{summary:${JSON.stringify(summary)}}};`,ctx);
 return {
  w,ctx,find,calls,notices,close:()=>w.close(),
  async open(){assert.equal(ctx.openCollectModal(),true);await wait();return find('dialog');},
  async method(key){find(`[data-collect-method="${key}"]`).click();await wait();return find('[data-collect-holder]');},
 };
}

(async()=>{
 const active=fixture();
 try{
  const dialog=await active.open();
  assert.equal(dialog.querySelector('h3').textContent,'Take payment');
  assert.equal(dialog.dataset.method,'cash','opening the sheet starts with a usable default even when card options are available');
  assert.equal(dialog.querySelector('[name=amount]').value,'65.00');
  assert.equal(dialog.querySelectorAll('form input:not([type=hidden])').length,1);
  assert.equal(dialog.querySelector('[data-collect-target]'),null);
  assert.equal(dialog.querySelector('[data-collect-submit]').textContent,'Record $65.00 cash');
  const disclosure=dialog.querySelector('[data-collect-past-balances]');
  assert.equal(disclosure.open,false);
  const prior=disclosure.querySelector('[data-collect-encounter=past]');
  assert.equal(prior.checked,false);
  disclosure.open=true;prior.click();await wait();
  assert.equal(dialog.querySelector('[data-collect-past-balances]').open,true);
  assert.equal(dialog.querySelector('[name=amount]').value,'90.00');
  assert.equal(dialog.querySelectorAll('form [name=amount]').length,1);
  assert.equal(dialog.querySelector('.collect-test-badge').textContent,'Test mode');
  assert.deepEqual(active.notices,[]);
  assert.equal(active.calls.some(call=>call[1]==='POST'),false);
 }finally{active.close();}

 for(const draft of [false,true]){
  const f=fixture({due:draft?2500:6500,draft});
  try{
   await f.open();
   for(const [key,id,button] of [
    ['reader','reader-copay-form','Take payment'],
    ['saved','saved-card-copay-form','Charge card on file'],
    ['link','hosted-copay-form','Prepare secure card checkout'],
   ]){
    const holder=await f.method(key),form=holder.querySelector('#'+id);
    assert.ok(form,holder.innerHTML);
    assert.equal(form.querySelector('[name=amount]').value,draft?'25.00':'65.00');
    assert.match(form.querySelector('[name=amount]').closest('label').textContent,draft?/Copay amount/:/^Amount \(USD\)$/);
    assert.equal(form.querySelector('[type=submit]').textContent,button);
    assert.equal(f.find('dialog').querySelectorAll('form [name=amount]').length,1);
   }
   assert.equal(f.calls.some(call=>call[1]==='POST'),false,'choosing a tender never records or charges a payment');
  }finally{f.close();}
 }

 const saved=fixture();
 try{
  const requests=[];
  let release;
  const response=new Promise(resolve=>{release=resolve;});
  saved.ctx.createSavedCardCopay=async(state,body,panel)=>{
   requests.push({patient:state.patient,appointment:state.appointment,body,panel});
   await response;
  };
  const dialog=await saved.open();
  await saved.method('saved');
  const form=dialog.querySelector('#saved-card-copay-form'),charge=form.querySelector('[type=submit]');
  assert.equal(charge.textContent,'Charge card on file');
  assert.equal(requests.length,0);
  charge.click();await wait();
  assert.ok(charge.disabled,'the charge stays disabled until its response');
  form.dispatchEvent(new saved.w.Event('submit',{bubbles:true,cancelable:true}));
  await wait();
  assert.equal(requests.length,1);
  assert.equal(requests[0].appointment,'appt');
  assert.equal(requests[0].patient,'patient');
  assert.equal(requests[0].body.amount_cents,6500);
  assert.equal(requests[0].body.saved_card_setup_id,'set-1');
  assert.ok(requests[0].body.request_id);
  assert.ok(requests[0].body.payment_group_id);
  assert.equal(requests[0].panel,'encounter-hosted-copay');
  assert.equal(dialog.querySelector('#saved-card-copay-confirm'),null);
  release();await wait();
  saved.ctx.activeVisit={id:'other-visit',appointment_id:'other-appt'};
  form.dispatchEvent(new saved.w.Event('submit',{bubbles:true,cancelable:true}));
  await assert.rejects(saved.ctx.pending,/Open the payment window for the current encounter/);
  assert.equal(requests.length,1);
 }finally{saved.close();}

 const unavailable=fixture({available:false});
 try{
  const dialog=await unavailable.open();
  assert.equal(dialog.dataset.method,'cash');
  assert.ok(dialog.querySelector('[data-collect-method=reader]').hidden);
  assert.ok(dialog.querySelector('[data-collect-method=saved]').hidden);
  assert.ok(dialog.querySelector('[data-collect-method=link]').hidden);
  Object.defineProperty(unavailable.w.navigator,'onLine',{configurable:true,value:false});
  unavailable.w.dispatchEvent(new unavailable.w.Event('offline'));
  assert.match(dialog.querySelector('[data-collect-availability]').textContent,/You’re offline/);
  assert.ok(dialog.querySelector('[data-collect-submit]').disabled);
 }finally{unavailable.close();}

 const settled=fixture({due:0});
 try{
  const dialog=await settled.open();
  assert.match(dialog.textContent,/No patient amount due/);
  assert.equal(dialog.querySelector('[data-collect-method]'),null);
  assert.equal(settled.calls.length,0);
 }finally{settled.close();}

 const pending=fixture({operations:[{id:'open',patient_id:'patient',appointment_id:'appt',status:'open',amount_cents:6500}]});
 try{
  const dialog=await pending.open();
  assert.match(dialog.querySelector('[data-collect-availability]').textContent,/Check the payment in progress/);
  assert.ok(Array.from(dialog.querySelectorAll('[data-collect-method]')).every(button=>button.disabled));
  assert.equal(dialog.querySelector('form'),null);
 }finally{pending.close();}

 const insurance=fixture({draft:true,due:2500});
 try{
  await insurance.ctx.openReaderCopayEditor('appt','insurance-hosted-copay');
  assert.match(insurance.find('#insurance-hosted-copay-reader').textContent,/Copay amount \(USD\)/);
 }finally{insurance.close();}
 console.log('PASS one payment amount, default tender, optional past balance, explicit card actions, settled and offline guards, and unchanged Insurance entry');
})().catch(error=>{console.error(error);process.exitCode=1;});
