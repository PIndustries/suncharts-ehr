// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Charging a card on file, cancelling an unfinished card link, and the forms that no longer
// ask for a confirmation box or a typed reason.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const read=name=>fs.readFileSync('web/'+name,'utf8');
const same=(actual,expected)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected));
const visibleText=html=>html.replace(/<[^>]*>/g,' ');
// Words for engineers, and long dashes, never reach front-desk staff.
const plain=(html,where)=>{const text=visibleText(html);assert.doesNotMatch(text,/\b(intent|session|off-session|off_session|Connect|payload|sandbox|idempotent|saved_card|setup_id)\b/i,where+': '+text);assert.doesNotMatch(text,/—/,where+': '+text);};
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const money=n=>`$${(n/100).toFixed(2)}`;
const visa={id:'pm_later',brand:'visa',last4:'4242',exp_month:4,exp_year:2030,charge_later:true,setup_id:'setup-later'},amex={id:'pm_second',brand:'amex',last4:'0005',exp_month:1,exp_year:2031,charge_later:true,setup_id:'setup-second'},old={id:'pm_old',brand:'mastercard',last4:'4444',exp_month:9,exp_year:2029,charge_later:false,setup_id:null};
const profile=(patient,cards)=>({patient_id:patient,livemode:false,payment_methods:{status:'available',data:{items:cards,has_more:false,next_cursor:null}},setup_available:true,active_setup:null});

// ---- The copay panel ---------------------------------------------------------------------
const base='/api/v1/patients/patient/appointments/appt/copay-checkouts';
const charged={id:'op',patient_id:'patient',appointment_id:'appt',amount_cents:2500,currency:'usd',livemode:false,status:'paid',channel:'saved_card',last_result:'provider_verified',checkout_url:null,receipt_id:'receipt',created_at:'2026-11-12T14:00:00Z'};
const link={id:'link',patient_id:'patient',appointment_id:'appt',amount_cents:2500,currency:'usd',livemode:false,status:'open',channel:'hosted',last_result:'provider_verified',checkout_url:'https://checkout.stripe.com/c/pay/cs_test_1',receipt_id:null,cancel_requested:false,created_at:'2026-11-12T14:00:00Z'};
function copay(cards=[visa,old]){
 const handlers={},nodes={},calls=[],timers=[];
 const appointment={id:'appt',patient_id:'patient',status:'checked_in',title:'Synthetic visit',starts_at:'2026-11-12T14:00:00Z'};
 const ctx={console,Date,Intl,URL,encodeURIComponent,crypto:{randomUUID:()=> 'stable-request'},me:{role:'front_desk'},selected:'patient',chartSection:'insurance',activeVisit:{id:'visit',appointment_id:'appt'},
  workspace:{patient:{id:'patient',given_name:'Synthetic',family_name:'Patient'},appointments:[appointment],visits:[{id:'visit',appointment_id:'appt'}],billing:{accounts:[],entries:[],copays:[],coverages:[{id:'coverage',content:{priority:'primary',status:'active',effective_date:'2026-01-01',copay_cents:2500}}]}},
  document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),querySelector:selector=>selector==='.sidebar-source .preview'?ctx.preview:null},$:id=>nodes[id]??null,esc,date:String,human:String,money,dollars:n=>(n/100).toFixed(2),cents:n=>Math.round(Number(n)*100),billingCan:()=>true,invoicePaymentMethod:String,
  // Nothing here may use the shared editor or move staff to another part of the chart.
  openBillingEditor:html=>{ctx.editor=html;calls.push(['openBillingEditor']);},showChartSection:section=>{ctx.chartSection=section;calls.push(['showChartSection',section]);},
  preview:{textContent:'Development preview · Synthetic data only'},notice:(...args)=>calls.push(['notice',...args]),run:fn=>ctx.pending=fn(),selectPatient:async(...args)=>calls.push(['selectPatient',...args]),
  FormData:class{constructor(form){return Object.entries(form.values)[Symbol.iterator]();}},
  setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;},localStorage:{getItem:()=>null,setItem(){}},
  availability:{available:true,livemode:false,reason:null},
  api:async(...args)=>{calls.push(args);if(args[0].endsWith('/payment-profile'))return profile('patient',cards);if(args[0]===base&&!args[1])return {items:ctx.items||[],availability:ctx.availability};if(typeof ctx.next==='function')return ctx.next(...args);return {operation:ctx.next};}};
 for(const id of ['encounter-hosted-copay-reader','insurance-hosted-copay-reader'])nodes[id]={id,_html:'',get innerHTML(){return this._html;},set innerHTML(html){this._html=html;if(html.includes('id="saved-card-payment-live"'))nodes['saved-card-payment-live']={innerHTML:''};else delete nodes['saved-card-payment-live'];},scrollIntoView(){}};
 ctx.window=ctx;vm.createContext(ctx);
 const billing=read('billing.js');vm.runInContext(billing.slice(billing.indexOf('function patientPrintBranding('),billing.indexOf('function patientInvoiceDocument(')),ctx);
 vm.runInContext(read('patient-revenue.js'),ctx);vm.runInContext(read('card-readers.js'),ctx);
 const click=(dataset,panel)=>{for(const handler of handlers.click)handler({target:{closest:selector=>selector==='button'?{dataset,disabled:false,hasAttribute:name=>name in dataset,closest:()=>panel?{id:panel}:null}:null},preventDefault(){}});return ctx.pending;};
 const submit=form=>{for(const handler of handlers.submit)handler({target:form,preventDefault(){},hasAttribute:()=>false});return ctx.pending;};
 const slot=(id='insurance-hosted-copay-reader')=>nodes[id].innerHTML;
 const live=()=>nodes['saved-card-payment-live']?.innerHTML??'';
 const tick=async next=>{ctx.next=next;const timer=timers.filter(t=>!t.cleared).at(-1);assert.ok(timer,'a status check is scheduled');assert.equal(timer.ms,2000);timer.cleared=true;await timer.fn();};
 const form=(values={},panel='')=>({id:'saved-card-copay-form',dataset:{panel,patient:'patient',appointment:'appt',coverage:'coverage',request:'stable-request',livemode:'false'},values:{amount:'25.00',card:'setup-later',...values},hasAttribute:()=>false});
 return {ctx,calls,timers,click,submit,slot,live,tick,form};
}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('the copay controls offer Charge card on file, and its form opens in place with eligible cards only',async()=>{
 const f=copay(),c=f.ctx,state=c.hostedCopayStateFor('appt');state.availability=c.availability;
 const panel=c.hostedCopayMarkup(state);
 assert.match(panel,/data-saved-card-copay="appt" >Charge card on file</);
 await f.click({savedCardCopay:'appt'},'encounter-hosted-copay');
 const html=f.slot('encounter-hosted-copay-reader');
 assert.match(html,/<h3>Charge card on file<\/h3>/);assert.match(html,/name="amount" required inputmode="decimal" value="25.00"/);
 assert.match(html,/Card: <b>visa ending 4242<\/b>/);assert.doesNotMatch(html,/4444/,'a card saved for in-person use is never offered');
 assert.doesNotMatch(html,/type="checkbox"|name="reason"/,'no confirmation box and no reason field');
 assert.match(html,/· Test payment/);plain(html,'copay card form');
 assert.equal(f.slot(),'','the other panel is untouched');
 assert.equal(f.calls.some(call=>['openBillingEditor','showChartSection','selectPatient'].includes(call[0])),false,'staff stay where they pressed the button');
 // Several eligible cards become a choice.
 const many=copay([visa,amex,old]);many.ctx.hostedCopayStateFor('appt').availability=many.ctx.availability;await many.click({savedCardCopay:'appt'},'insurance-hosted-copay');
 assert.match(many.slot(),/<select name="card" required><option value="setup-later">visa ending 4242<\/option><option value="setup-second">amex ending 0005<\/option><\/select>/);
 // Only an in-person card on file: staff are told plainly and nothing can be charged.
 const none=copay([old]);none.ctx.hostedCopayStateFor('appt').availability=none.ctx.availability;await none.click({savedCardCopay:'appt'},'insurance-hosted-copay');
 assert.match(none.slot(),/The card on file was saved for in-person use\. Ask the patient to save it again to charge it later\./);assert.doesNotMatch(none.slot(),/type="submit"/);plain(none.slot(),'no eligible card');
});

test('the amount is confirmed, then the result reads Approved with the receipt',async()=>{
 const f=copay(),c=f.ctx;c.hostedCopayStateFor('appt').availability=c.availability;
 await f.click({savedCardCopay:'appt'},'insurance-hosted-copay');
 await f.submit(f.form({amount:'30.00'},'insurance-hosted-copay'));
 let html=f.slot();
 assert.match(html,/Charge <b>\$30\.00<\/b> to visa ending 4242\?/);assert.match(html,/data-saved-card-copay-charge>Charge \$30\.00</);assert.match(html,/data-saved-card-copay-back>Back</);
 assert.equal(f.calls.filter(call=>call[1]==='POST').length,0,'nothing is charged before the amount is confirmed');
 c.next={...charged,amount_cents:3000};await f.click({savedCardCopayCharge:''});
 same(f.calls.find(call=>call[1]==='POST'),[base,'POST',{request_id:'stable-request',amount_cents:3000,coverage_id:'coverage',livemode:false,reason:'Copay charged to card on file',saved_card_setup_id:'setup-later'}]);
 html=f.live();assert.match(html,/data-saved-card-payment="approved"/);assert.match(html,/<b>Approved<\/b>/);assert.match(html,/\$30\.00 · Test payment/);
 assert.match(html,/data-hosted-copay-receipt="receipt" data-appointment="appt">View \/ print receipt</);plain(html,'approved');
 assert.equal(f.timers.filter(t=>!t.cleared).length,0,'a finished charge is not checked again');
 // Back returns to the form with the amount staff typed.
 const g=copay();g.ctx.hostedCopayStateFor('appt').availability=g.ctx.availability;await g.click({savedCardCopay:'appt'},'insurance-hosted-copay');await g.submit(g.form({amount:'12.00'},'insurance-hosted-copay'));await g.click({savedCardCopayBack:''});
 assert.match(g.slot(),/id="saved-card-copay-form"/);assert.match(g.slot(),/value="12.00"/);
 // On a production build a test payment carries no label.
 f.ctx.preview={textContent:'Production'};assert.doesNotMatch(f.ctx.savedCardPaymentMarkup({operation:charged}),/Test payment/);
});

test('Declined and a bank that wants the patient are plain, and the card link is one press away',async()=>{
 const f=copay(),c=f.ctx,state=c.hostedCopayStateFor('appt');state.availability=c.availability;
 await f.click({savedCardCopay:'appt'},'insurance-hosted-copay');await f.submit(f.form({},'insurance-hosted-copay'));
 c.next={...charged,status:'expired',last_result:'saved_card_declined',receipt_id:null};await f.click({savedCardCopayCharge:''});
 let html=f.live();assert.match(html,/data-saved-card-payment="declined"/);assert.match(html,/<b>Declined<\/b>/);assert.match(html,/Nothing was charged\. Try another card or another way to pay\./);assert.doesNotMatch(html,/data-saved-card-link/);plain(html,'declined');
 // The closed charge no longer blocks the appointment: every way to pay is offered again.
 assert.doesNotMatch(c.hostedCopayMarkup(state),/disabled/);assert.match(c.hostedCopayOperationMarkup(state.items[0]),/Declined/);
 await f.click({savedCardCopay:'appt'},'insurance-hosted-copay');await f.submit(f.form({},'insurance-hosted-copay'));
 const asked={...charged,id:'asked',status:'expired',last_result:'saved_card_needs_patient',receipt_id:null};c.next=asked;await f.click({savedCardCopayCharge:''});
 html=f.live();assert.match(html,/data-saved-card-payment="confirm"/);assert.match(html,/<b>The bank needs the patient to confirm - send a card link instead<\/b>/);assert.match(html,/data-saved-card-link>Create card link</);plain(html,'bank confirmation');
 const before=f.calls.length;c.next=link;await f.click({savedCardLink:''});
 same(f.calls.slice(before),[[base,'POST',{request_id:'stable-request',amount_cents:2500,coverage_id:'coverage',livemode:false,reason:'Card link sent after the bank asked the patient to confirm'}]]);
 assert.match(f.slot(),/Card link created\. Open it or send it from the copay list\./);
 const list=c.hostedCopayMarkup(state);assert.match(list,/Continue to Stripe checkout/);assert.match(list,/data-cancel-copay-link="link" data-appointment="appt">Cancel link</);
 assert.equal(f.calls.some(call=>['openBillingEditor','showChartSection'].includes(call[0])),false);
 // A charge the bank is still working on is checked every two seconds until it ends.
 const g=copay(),gc=g.ctx;gc.hostedCopayStateFor('appt').availability=gc.availability;await g.click({savedCardCopay:'appt'},'insurance-hosted-copay');await g.submit(g.form({},'insurance-hosted-copay'));
 gc.next={...charged,status:'open',last_result:'saved_card_processing',receipt_id:null};await g.click({savedCardCopayCharge:''});
 assert.match(g.live(),/<b>Charging the card<\/b>/);await g.tick(charged);
 same(g.calls.at(-1),[`${base}/op/refresh`,'POST',{}]);assert.match(g.live(),/<b>Approved<\/b>/);
});

test('an open card link has Cancel link; afterwards it reads Cancelled and another payment can start',async()=>{
 const f=copay(),c=f.ctx,state=c.hostedCopayStateFor('appt');state.availability=c.availability;state.items=[link];
 let panel=c.hostedCopayMarkup(state);
 assert.match(panel,/data-cancel-copay-link="link" data-appointment="appt">Cancel link</);assert.doesNotMatch(panel,/data-collect-card-copay|data-reader-copay|data-saved-card-copay/,'an open link blocks the next payment until it is cancelled');
 c.next={...link,status:'expired',last_result:'link_cancelled',checkout_url:null};await f.click({cancelCopayLink:'link',appointment:'appt'});
 same(f.calls.at(-1),[`${base}/link/cancel`,'POST',{}]);
 panel=c.hostedCopayMarkup(state);
 assert.match(panel,/\$25\.00 · Cancelled/);assert.doesNotMatch(panel,/Continue to Stripe checkout|data-cancel-copay-link|disabled/);
 assert.match(panel,/data-collect-card-copay="appt" >Collect card copay</);assert.match(panel,/data-reader-copay="appt" >/);assert.match(panel,/data-saved-card-copay="appt" >/);plain(panel,'cancelled link');
 // A link the patient paid in the same moment is shown as paid, never as cancelled.
 state.items=[link];c.next={...link,status:'paid',receipt_id:'receipt',checkout_url:null};await f.click({cancelCopayLink:'link',appointment:'appt'});
 assert.match(c.hostedCopayOperationMarkup(state.items[0]),/Card payment verified/);assert.doesNotMatch(c.hostedCopayOperationMarkup(state.items[0]),/Cancelled/);
 // While the cancel is still on its way the row says so and offers no second cancel.
 const waiting=c.hostedCopayOperationMarkup({...link,cancel_requested:true});assert.match(waiting,/Cancelling/);assert.doesNotMatch(waiting,/data-cancel-copay-link/);
 // Reader payments and card charges are not links.
 for(const channel of ['reader','saved_card'])assert.doesNotMatch(c.hostedCopayOperationMarkup({...link,channel,checkout_url:null,last_result:'reader_waiting'}),/data-cancel-copay-link/);
});

test('the card link copay form has no confirmation box; the cash and check form keeps its box',async()=>{
 const f=copay(),c=f.ctx;
 await c.openHostedCopayEditor('appt','insurance-hosted-copay');
 assert.doesNotMatch(f.slot(),/type="checkbox"|name="reviewed"|I reviewed/);assert.match(f.slot(),/name="amount" required/);
 c.next=link;await f.submit({id:'hosted-copay-form',dataset:{patient:'patient',appointment:'appt',coverage:'coverage',request:'stable-request',livemode:'false'},values:{amount:'25.00'},hasAttribute:()=>false});
 same(f.calls.find(call=>call[1]==='POST'),[base,'POST',{request_id:'stable-request',amount_cents:2500,coverage_id:'coverage',livemode:false,reason:'Reviewed appointment copay before hosted card collection'}]);
 c.chartSection='insurance';c.openCopayReceiptEditor('appt');
 assert.match(c.editor,/name="received_confirmed" required> I confirm this payment has already been received\./);
});

// ---- Payment plans -----------------------------------------------------------------------
const patient='11111111-1111-4111-8111-111111111111';
function plans(cards=[visa,old]){
 const nodes={},calls=[],handlers={},timers=[],identity={tenant_id:'tenant',user_id:'owner',role:'front_desk'};
 const node=id=>nodes[id]={id,_html:'',get innerHTML(){return this._html;},set innerHTML(html){this._html=html;if(id==='installment-collection'){if(html.includes('id="saved-card-payment-live"'))node('saved-card-payment-live');else delete nodes['saved-card-payment-live'];}},isConnected:true,querySelector:selector=>selector.startsWith('#')?nodes[selector.slice(1)]||null:null,querySelectorAll:()=>[],replaceChildren(){this.innerHTML='';},scrollIntoView(){},insertAdjacentHTML(_where,html){this.innerHTML+=html;}};
 for(const id of ['patient-billing-installments','installment-plan-review','installment-collection'])node(id);
 const host=node('hub');
 const plan={id:'plan-one',request_id:'plan-request',reason:'Agreed plan',patient_id:patient,invoice_id:'invoice-one',account_id:'account-one',version:4,status:'active',livemode:false,total_cents:500,remaining_cents:500,autopay:false,installments:[{number:1,due_on:'2026-11-30',amount_cents:250,collected_cents:0,collectible_cents:250,status:'pending'}],attempts:[]};
 const s={identity,patientId:patient,tab:'subscriptions',host,planRequest:1,installmentAvailability:{available:true,livemode:false},installmentPlans:[plan],eligibleInvoices:[]};
 const ctx={console,URL,Date,Intl,Map,Set,Symbol,WeakMap,encodeURIComponent,crypto:{randomUUID:()=> 'stable-request'},me:identity,patientBillingWorkspace:s,document:{addEventListener:(k,v)=>(handlers[k]??=[]).push(v),querySelector:selector=>selector==='.sidebar-source .preview'?ctx.preview:null},preview:{textContent:'Development preview'},$:id=>nodes[id]||null,patientBillingCurrent:value=>value===s,billingCan:()=>true,esc,human:v=>String(v??'').replaceAll('_',' '),money,dollars:v=>(v/100).toFixed(2),date:String,patientBillingCheckoutUrl:v=>v&&v.startsWith('https://checkout.stripe.com/')?v:null,notice(){},run:fn=>ctx.pending=fn(),localStorage:{getItem:()=>null,setItem(){}},
  setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;},
  api:async(path,method='GET',body,version)=>{calls.push([path,method,body,version]);if(path.endsWith('/payment-profile'))return profile(patient,cards);if(typeof ctx.next==='function')return ctx.next(path,method,body);if(path.endsWith('/installment-plans'))return {items:s.installmentPlans,eligible_invoices:[],availability:s.installmentAvailability};return ctx.next;}};
 vm.createContext(ctx);vm.runInContext(read('card-readers.js'),ctx);vm.runInContext(read('patient-payment-plans.js'),ctx);
 const form=()=>{const choice={innerHTML:''};return {isConnected:true,dataset:{plan:'plan-one',version:'4',number:'1',amount:'250'},elements:{reason:{value:''},card:{value:'setup-later'},patient_present:{checked:true}},choice,querySelector:selector=>selector==='#installment-saved-card-choice'?choice:null};};
 return {ctx,s,plan,nodes,calls,timers,form};
}
const attempt={id:'attempt',request_id:'stable-request',patient_id:patient,plan_id:'plan-one',account_id:'account-one',installment_number:1,amount_cents:250,livemode:false,status:'paid',channel:'saved_card',last_result:'provider_verified',checkout_url:null,paid_entry_id:'entry',refunded_cents:0,unapplied_cents:0};

test('an installment can be charged to a card on file from its own form, without a reason or the patient',async()=>{
 const f=plans(),c=f.ctx;
 c.openInstallmentCollection(f.s,'plan-one',1);
 const html=f.nodes['installment-collection'].innerHTML;
 assert.match(html,/<label>Collection reason \(optional\)<input name="reason" maxlength="1000" autocomplete="off" value="" ><\/label>/,'the reason is no longer required');
 assert.match(html,/<input name="patient_present" type="checkbox" required> The patient is present and agrees to this payment amount\./,'the card link keeps its patient-present box');
 assert.match(html,/data-installment-saved-card>Charge card on file</);assert.match(html,/· Test payment/);assert.doesNotMatch(html,/Stripe Sandbox/);
 const form=f.form();await c.chooseInstallmentSavedCard(f.s,form);
 assert.match(form.choice.innerHTML,/Card: <b>visa ending 4242<\/b>/);assert.match(form.choice.innerHTML,/\$2\.50 will be charged to the card\. The patient does not need to be here\./);assert.match(form.choice.innerHTML,/data-installment-saved-card-pay>Charge \$2\.50</);
 assert.doesNotMatch(form.choice.innerHTML,/4444|type="checkbox"/);plain(form.choice.innerHTML,'installment card choice');
 c.next={plan:{...f.plan,attempts:[attempt]},operation:attempt};await c.chargeInstallmentSavedCard(f.s,form);
 same(f.calls.find(call=>call[1]==='POST'),[`/api/v1/billing/patients/${patient}/installment-plans/plan-one/installments/1/checkout`,'POST',{request_id:'stable-request',amount_cents:250,patient_present:false,reason:'Installment charged to card on file',saved_card_setup_id:'setup-later'},4]);
 const live=f.nodes['saved-card-payment-live'].innerHTML;assert.match(live,/<b>Approved<\/b>/);assert.match(live,/The payment is recorded in the patient ledger\./);
 // The card link form sends a standard reason when staff leave it blank.
 const g=plans(),link={...attempt,channel:'hosted',status:'open',paid_entry_id:null,checkout_url:'https://checkout.stripe.com/c/pay/cs_test_2'};g.ctx.next={plan:{...g.plan,attempts:[link]},operation:link};
 await g.ctx.createInstallmentCheckout(g.s,g.form());
 same(g.calls.find(call=>call[1]==='POST')[2],{request_id:'stable-request',amount_cents:250,patient_present:true,reason:'Installment card link'});
 const unticked=g.form();unticked.elements.patient_present.checked=false;const posts=g.calls.filter(call=>call[1]==='POST').length;await g.ctx.createInstallmentCheckout(g.s,unticked);assert.equal(g.calls.filter(call=>call[1]==='POST').length,posts);
});

test('when the bank wants the patient, one press creates the installment card link; links can be cancelled',async()=>{
 const f=plans(),c=f.ctx,asked={...attempt,status:'expired',last_result:'saved_card_needs_patient',paid_entry_id:null};
 c.next={plan:{...f.plan,version:5,attempts:[asked]},operation:asked};await c.chargeInstallmentSavedCard(f.s,f.form());
 let live=f.nodes['saved-card-payment-live'].innerHTML;assert.match(live,/The bank needs the patient to confirm - send a card link instead/);assert.match(live,/data-saved-card-link>Create card link</);
 const made={...attempt,id:'made',channel:'hosted',status:'open',paid_entry_id:null,checkout_url:'https://checkout.stripe.com/c/pay/cs_test_3',cancel_requested:false};
 c.next=(path,method)=>method==='POST'?{plan:{...f.plan,version:6,attempts:[asked,made]},operation:made}:{items:f.s.installmentPlans,eligible_invoices:[],availability:f.s.installmentAvailability};
 await vm.runInContext('savedCardPaymentLive',c).link(asked);
 same(f.calls.filter(call=>call[1]==='POST').at(-1),[`/api/v1/billing/patients/${patient}/installment-plans/plan-one/installments/1/checkout`,'POST',{request_id:'stable-request',amount_cents:250,patient_present:false,reason:'Card link sent after the bank asked the patient to confirm',after_saved_card:'attempt'},5]);
 assert.match(f.nodes['installment-collection'].innerHTML,/Card link created\. Open it or send it from the plan above\./);
 const row=c.installmentOperationMarkup(made);
 assert.match(row,/Continue secure installment checkout/);assert.match(row,/data-cancel-invoice-link="made">Cancel link</);
 c.next=(path,method)=>method==='POST'?{operation:{...made,status:'expired',last_result:'link_cancelled',checkout_url:null}}:{items:f.s.installmentPlans,eligible_invoices:[],availability:f.s.installmentAvailability};
 await c.cancelInstallmentLink(f.s,'made');
 same(f.calls.filter(call=>call[1]==='POST').at(-1).slice(0,3),['/api/v1/billing/invoice-checkouts/made/cancel','POST',{}]);
 const cancelled=c.installmentOperationMarkup({...made,status:'expired',last_result:'link_cancelled',checkout_url:null});
 assert.match(cancelled,/<b>Cancelled · \$2\.50<\/b> · Test payment/);assert.doesNotMatch(cancelled,/data-cancel-invoice-link|Continue secure/);
 assert.match(c.installmentOperationMarkup(asked),/The bank needs the patient to confirm/);assert.match(c.installmentOperationMarkup({...asked,last_result:'saved_card_declined'}),/<b>Declined · \$2\.50<\/b>/);
 assert.match(c.installmentPlanMarkup(f.plan,f.s),/<span class="pill">active · Test payment<\/span>/);
 c.preview={textContent:'Production'};assert.doesNotMatch(c.installmentPlanMarkup(f.plan,f.s)+c.installmentOperationMarkup(made),/Test payment|Stripe Sandbox/);
});

// ---- Cards on file and patient balance ---------------------------------------------------
function workspace(cards=[visa,old]){
 const nodes={},calls=[],handlers={},timers=[],identity={tenant_id:'tenant',user_id:'user',role:'front_desk'};
 const slot={dataset:{balanceSlot:'invoice-one'},_html:'',get innerHTML(){return this._html;},set innerHTML(html){this._html=html;if(html.includes('id="saved-card-payment-live"'))nodes['saved-card-payment-live']={innerHTML:''};else delete nodes['saved-card-payment-live'];},replaceChildren(){this.innerHTML='';}};
 const part=id=>nodes[id]={id,innerHTML:'',hidden:true,isConnected:true,replaceChildren(){this.innerHTML='';}};
 for(const id of ['patient-billing-balances','patient-billing-profile-section'])part(id);
 const host={id:'hub',isConnected:true,querySelector:selector=>selector.startsWith('#')?nodes[selector.slice(1)]||null:null,querySelectorAll:selector=>selector==='[data-balance-slot]'?[slot]:[]};
 nodes.hub=host;nodes.tools={hidden:false};
 const s={identity,host,surface:'global',patientId:patient,tab:'overview',panelRequest:1,profileRequest:0,profileCursors:{},profile:profile(patient,cards)};
 const ctx={console,URL,URLSearchParams,Date,Intl,Map,Set,Symbol,encodeURIComponent,crypto:{randomUUID:()=> 'stable-request'},me:identity,selected:patient,workspace:{},document:{addEventListener:(k,v)=>(handlers[k]??=[]).push(v),querySelector:selector=>selector==='.sidebar-source .preview'?ctx.preview:null},preview:{textContent:'Development preview'},$:id=>nodes[id]||null,billingCan:()=>true,esc,human:String,money,date:String,notice(){},run:fn=>ctx.pending=fn(),localStorage:{getItem:()=>null,setItem(){}},
  setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;},
  api:async(path,method='GET',body,version)=>{calls.push([path,method,body,version]);if(path.endsWith('/payment-profile'))return s.profile;return ctx.next(path,method,body);}};
 vm.createContext(ctx);vm.runInContext(read('card-readers.js'),ctx);vm.runInContext(read('patient-billing-workspace.js'),ctx);
 ctx.adopt=s;vm.runInContext('patientBillingWorkspace=adopt;patientBillingSetupOwner=me;',ctx);
 return {ctx,s,nodes,calls,slot,setups:vm.runInContext('patientBillingSetups',ctx)};
}

test('cards saved before later charges are shown as in-person only, and an open card link can be cancelled',async()=>{
 const f=workspace(),c=f.ctx;f.s.tab='methods';
 let html=c.patientBillingProfileMarkup(f.s.profile,'methods',f.s);
 assert.match(html,/4242<\/strong><small>Expires 04\/2030<\/small><small class="payment-card-use">Can be charged later<\/small>/);
 assert.match(html,/4444<\/strong><small>Expires 09\/2029<\/small><small class="payment-card-use">Saved for in-person use - ask the patient to save it again to charge it later<\/small>/);
 assert.match(html,/agrees there that the practice may charge it later\. Nothing is charged now\./);plain(html,'cards on file');
 f.setups.set(patient,{request_id:'setup-open',patient_id:patient,status:'open',session:{url:'https://checkout.stripe.com/c/pay/cs_test_setup'}});
 html=c.patientBillingProfileMarkup(f.s.profile,'methods',f.s);
 assert.match(html,/data-hub-setup-cancel-link>Cancel this link</);assert.doesNotMatch(html,/data-hub-add-method/,'an open link blocks the next one until it is cancelled');
 c.next=()=>({request_id:'setup-open',patient_id:patient,status:'expired',cancelled:true,session:{url:null},retry_allowed:false});
 await c.patientBillingCancelSetup(f.s);
 same(f.calls.find(call=>call[1]==='POST').slice(0,3),['/api/v1/billing/payment-setups/setup-open/cancel','POST',{}]);
 html=f.nodes['patient-billing-profile-section'].innerHTML;
 assert.match(html,/<h4>Cancelled<\/h4><p>Start again to get a new link\.<\/p>/);assert.doesNotMatch(html,/data-hub-setup-cancel-link|Open Stripe/);
 assert.match(html,/data-hub-add-method>Add card</,'another card link can be started straight away');assert.match(html,/data-hub-add-method-link>Send the patient a link</);plain(html,'cancelled card link');
 // The patient finished first: the card is saved and nothing reads as cancelled.
 f.setups.set(patient,{request_id:'setup-open',patient_id:patient,status:'open',session:{url:'https://checkout.stripe.com/c/pay/cs_test_setup'}});
 c.next=()=>({request_id:'setup-open',patient_id:patient,status:'succeeded',cancelled:false,session:{url:null}});await c.patientBillingCancelSetup(f.s);
 html=f.nodes['patient-billing-profile-section'].innerHTML;assert.match(html,/<h4>Card saved<\/h4>/);assert.doesNotMatch(html,/Cancelled/);
});

test('a patient balance is charged to a card on file directly under the balance',async()=>{
 const f=workspace(),c=f.ctx,invoice={invoice_id:'invoice-one',invoice_created_at:'2026-11-11',remaining_cents:3000,eligible:true,existing_plan_id:null};
 c.next=()=>({items:[],eligible_invoices:[invoice,{...invoice,invoice_id:'planned',eligible:false,existing_plan_id:'other'}],availability:{available:true,livemode:false}});
 await c.loadPatientBillingBalances(f.s,1);
 const list=f.nodes['patient-billing-balances'];assert.equal(list.hidden,false);
 assert.match(list.innerHTML,/<h3>Balance due<\/h3>/);assert.match(list.innerHTML,/<b>\$30\.00<\/b><small>Invoice issued 2026-11-11<\/small>/);assert.match(list.innerHTML,/data-balance-saved-card="invoice-one">Charge card on file</);assert.doesNotMatch(list.innerHTML,/planned/);plain(list.innerHTML,'balance list');
 await c.openBalanceSavedCard(f.s,'invoice-one');
 assert.match(f.slot.innerHTML,/Card: <b>visa ending 4242<\/b>/);assert.match(f.slot.innerHTML,/\$30\.00 will be charged to the card\./);assert.match(f.slot.innerHTML,/<button type="submit" class="primary">Charge \$30\.00<\/button>/);assert.doesNotMatch(f.slot.innerHTML,/type="checkbox"|name="reason"|4444/);
 const operation={id:'balance-op',patient_id:patient,plan_id:'balance-plan',amount_cents:3000,livemode:false,status:'expired',channel:'saved_card',last_result:'saved_card_needs_patient'};
 c.next=()=>({plan:{id:'balance-plan',invoice_id:'invoice-one',version:3},operation});
 await c.chargeBalanceSavedCard(f.s,{dataset:{invoice:'invoice-one',amount:'3000',request:'stable-request'},elements:{card:{value:'setup-later'}}});
 same(f.calls.find(call=>call[1]==='POST').slice(0,3),[`/api/v1/billing/patients/${patient}/invoices/invoice-one/saved-card-charge`,'POST',{request_id:'stable-request',amount_cents:3000,saved_card_setup_id:'setup-later'}]);
 assert.match(f.nodes['saved-card-payment-live'].innerHTML,/The bank needs the patient to confirm - send a card link instead/);
 const made={id:'balance-link',patient_id:patient,plan_id:'balance-plan',status:'open',checkout_url:'https://checkout.stripe.com/c/pay/cs_test_4'};
 c.next=(path,method)=>method==='POST'?{plan:{id:'balance-plan'},operation:made}:{id:'balance-plan',version:4};
 await vm.runInContext('savedCardPaymentLive',c).link(operation);
 same(f.calls.filter(call=>call[1]==='POST').at(-1),[`/api/v1/billing/patients/${patient}/installment-plans/balance-plan/installments/1/checkout`,'POST',{request_id:'stable-request',amount_cents:3000,patient_present:false,reason:'Card link sent after the bank asked the patient to confirm',after_saved_card:'balance-op'},4]);
 assert.match(f.slot.innerHTML,/<h4>Card link ready<\/h4>/);assert.match(f.slot.innerHTML,/href="https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_4"/);assert.match(f.slot.innerHTML,/data-cancel-balance-link="balance-link" data-invoice="invoice-one">Cancel link</);plain(f.slot.innerHTML,'balance card link');
 c.next=()=>({operation:{...made,status:'expired',last_result:'link_cancelled',checkout_url:null}});await c.cancelBalanceLink(f.s,'balance-link','invoice-one');
 assert.match(f.slot.innerHTML,/Card link cancelled\./);
 // Approved is the same wording everywhere.
 c.next=()=>({plan:{id:'balance-plan',invoice_id:'invoice-one',version:3},operation:{...operation,status:'paid',last_result:'provider_verified'}});
 await c.chargeBalanceSavedCard(f.s,{dataset:{invoice:'invoice-one',amount:'3000',request:'stable-request'},elements:{card:{value:'setup-later'}}});
 assert.match(f.nodes['saved-card-payment-live'].innerHTML,/<b>Approved<\/b>/);
 // Test payments are labelled on a preview build only.
 const mode={...f.s,mode:'test'};assert.match(c.patientBillingTestNotice(mode),/<p class="copay-mode-label">Test payment<\/p>/);c.preview={textContent:'Production'};assert.equal(c.patientBillingTestNotice(mode),'');
});

(async()=>{
 for(const [name,fn] of tests){try{await fn();}catch(error){console.error('FAIL '+name);throw error;}}
 console.log(`PASS card on file: ${tests.length} checks for charging in place, approved, declined and bank confirmation, one-press card links, cancelling open links, in-person cards and removed confirmation boxes`);
})().catch(error=>{console.error(error);process.exitCode=1;});
