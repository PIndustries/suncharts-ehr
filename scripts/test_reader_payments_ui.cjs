// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Taking a copay on a card reader: choosing the reader, the live status area and its wording.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const frontDesk={id:'tmr_front',name:'Front desk',model:'BBPOS WisePOS E',online:true,busy:false},back={id:'tmr_back',name:'Back office',model:'Stripe Reader S700',online:true,busy:false};
const base='/api/v1/patients/patient/appointments/appt/copay-checkouts',readersPath='/api/v1/billing/payments/readers';
const op={id:'op',patient_id:'patient',appointment_id:'appt',amount_cents:2500,currency:'usd',livemode:false,status:'open',channel:'reader',reader_id:'tmr_front',last_result:'reader_waiting',checkout_url:null,receipt_id:null,created_at:'2026-11-12T14:00:00Z'};
const same=(actual,expected)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected));
const visibleText=html=>html.replace(/<[^>]*>/g,' ');
function fixture(readers=[frontDesk]){
 const handlers={},nodes={},calls=[],timers=[],store=new Map();
 const appointment={id:'appt',patient_id:'patient',status:'checked_in',title:'Synthetic visit',starts_at:'2026-11-12T14:00:00Z'};
 const ctx={console,Date,Intl,URL,encodeURIComponent,crypto:{randomUUID:()=> 'stable-request'},me:{role:'front_desk'},selected:'patient',chartSection:'insurance',activeVisit:{id:'visit',appointment_id:'appt'},
  workspace:{patient:{id:'patient',given_name:'Synthetic',family_name:'Patient'},appointments:[appointment],visits:[{id:'visit',appointment_id:'appt'}],billing:{accounts:[],entries:[],copays:[],coverages:[{id:'coverage',content:{priority:'primary',status:'active',effective_date:'2026-01-01',copay_cents:2500}}]}},
  document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),documentElement:{dataset:{}},querySelector:()=>null},$:id=>nodes[id]??null,esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),date:String,human:String,money:n=>`$${(n/100).toFixed(2)}`,dollars:n=>(n/100).toFixed(2),cents:n=>Math.round(Number(n)*100),billingCan:()=>true,invoicePaymentMethod:String,
  openBillingEditor:html=>{ctx.editor=html;if(html.includes('id="reader-payment-live"'))nodes['reader-payment-live']={innerHTML:''};else delete nodes['reader-payment-live'];},
  showChartSection:section=>ctx.chartSection=section,notice:(...args)=>calls.push(['notice',...args]),run:fn=>ctx.pending=fn(),selectPatient:async(...args)=>calls.push(['selectPatient',...args]),
  FormData:class{constructor(form){return Object.entries(form.values)[Symbol.iterator]();}},
  setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;},
  localStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)},
  availability:{available:true,livemode:false,reason:null},readers:{status:'ready',readers,can_manage:false,payments_available:true},
  // The copay list, the reader list, and whatever the test queues for the payment itself.
  api:async(...args)=>{calls.push(args);if(args[0]===readersPath)return ctx.readers;if(args[0]===base&&!args[1])return {items:ctx.items||[],availability:ctx.availability};if(typeof ctx.next==='function')return ctx.next(...args);return {operation:ctx.next};}};
 ctx.window=ctx;vm.createContext(ctx);
 const billing=fs.readFileSync('web/billing.js','utf8');vm.runInContext(billing.slice(billing.indexOf('function patientPrintBranding('),billing.indexOf('function patientInvoiceDocument(')),ctx);
 vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/card-readers.js','utf8'),ctx);
 const click=dataset=>{for(const handler of handlers.click)handler({target:{closest:selector=>selector==='button'?{dataset,hasAttribute:name=>name in dataset}:null},preventDefault(){}});return ctx.pending;};
 const submit=form=>{for(const handler of handlers.submit)handler({target:form,preventDefault(){}});return ctx.pending;};
 // The next scheduled status read, as the two-second timer would run it.
 const tick=async next=>{ctx.next=next;const timer=timers.filter(t=>!t.cleared).at(-1);assert.ok(timer,'a status read is scheduled');assert.equal(timer.ms,2000);timer.cleared=true;await timer.fn();};
 const waiting=()=>timers.filter(t=>!t.cleared).length;
 const live=()=>nodes['reader-payment-live']?.innerHTML??'';
 const form=(values={})=>({id:'reader-copay-form',dataset:{patient:'patient',appointment:'appt',coverage:'coverage',request:'stable-request',livemode:'false'},values:{amount:'25.00',reviewed:'on',reader:'tmr_front',...values}});
 return {ctx,handlers,nodes,calls,timers,store,click,submit,tick,waiting,live,form};
}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('the reader button sits beside the card link and is left out until card payments are set up',async()=>{
 const f=fixture(),c=f.ctx;await c.loadHostedCopays('appt');
 let panel=c.hostedCopayMarkup(c.hostedCopayStateFor('appt'));
 assert.match(panel,/data-collect-card-copay="appt" >Collect card copay<\/button><button type="button" data-reader-copay="appt" >Take card payment on reader<\/button>/);
 c.availability={available:false,livemode:null,reason:'Finish payment setup.'};await c.loadHostedCopays('appt',true);
 panel=c.hostedCopayMarkup(c.hostedCopayStateFor('appt'));assert.doesNotMatch(panel,/data-reader-copay|on reader/);assert.match(panel,/Collect card copay/);
});
test('with no reader set up the owner is taken to Card readers and other staff are told who to ask',async()=>{
 let f=fixture([]),c=f.ctx,opened=0;c.openCardReaders=async()=>{opened++;};
 await assert.rejects(f.click({readerCopay:'appt'}),/No card reader is set up yet\. Ask the practice owner to add one\./);assert.equal(opened,0);assert.equal(c.editor,undefined);
 f=fixture([]);c=f.ctx;c.me={role:'owner'};c.openCardReaders=async()=>{opened++;};await f.click({readerCopay:'appt'});assert.equal(opened,1);assert.equal(c.editor,undefined,'no payment form without a reader');
 f=fixture();c=f.ctx;c.readers={status:'ready',readers:[frontDesk],payments_available:false};await assert.rejects(f.click({readerCopay:'appt'}),/not available for this practice yet/);
 f=fixture();c=f.ctx;c.readers={status:'not_connected',readers:[]};await assert.rejects(f.click({readerCopay:'appt'}),/not available for this practice yet/);
});
test('the form shows the amount and the reader, and remembers the last reader used on this computer',async()=>{
 let f=fixture(),c=f.ctx;await f.click({readerCopay:'appt'});
 assert.match(c.editor,/<form id="reader-copay-form" data-patient="patient" data-appointment="appt" data-coverage="coverage" data-livemode="false" data-request="stable-request"><h3>Take card payment on reader<\/h3>/);
 assert.match(c.editor,/Recorded plan copay: \$25\.00\./);assert.match(c.editor,/<label>Copay amount \(USD\)<input name="amount" required inputmode="decimal" value="25.00">/);
 assert.match(c.editor,/<input type="hidden" name="reader" value="tmr_front"><p>Reader: <b>Front desk<\/b><\/p>/,'one reader needs no choice');
 assert.match(c.editor,/<button type="submit" class="primary">Take payment<\/button>/);assert.match(c.editor,/Test payment/);
 f=fixture([frontDesk,back]);c=f.ctx;await f.click({readerCopay:'appt'});
 assert.match(c.editor,/<label>Reader<select name="reader" required><option value="tmr_front" selected>Front desk<\/option><option value="tmr_back" >Back office<\/option><\/select><\/label>/);
 c.next={...op,reader_id:'tmr_back'};await f.submit(f.form({reader:'tmr_back'}));
 const sent=f.calls.find(call=>call[1]==='POST');
 same(sent,[base,'POST',{request_id:'stable-request',amount_cents:2500,coverage_id:'coverage',livemode:false,reason:'Reviewed appointment copay before card reader collection',reader_id:'tmr_back'}]);
 assert.equal(f.store.get('suncharts.cardReader'),'tmr_back');
 assert.match(f.live(),/Waiting for card on Back office/);
 c.stopReaderPayment();c.hostedCopayStateFor('appt').items=[];c.items=[];await f.click({readerCopay:'appt'});
 assert.match(c.editor,/<option value="tmr_front" >Front desk<\/option><option value="tmr_back" selected>Back office<\/option>/,'the last reader used is offered first');
 await assert.rejects(f.submit(f.form({reviewed:undefined})),/Review the copay amount/);await assert.rejects(f.submit(f.form({reader:''})),/Choose a card reader/);
});
test('the status area follows the payment from waiting to approved and shows the receipt step',async()=>{
 const f=fixture(),c=f.ctx;await f.click({readerCopay:'appt'});c.next=op;await f.submit(f.form());
 assert.equal(c.editor,'<div id="reader-payment-live"></div>');
 let html=f.live();
 assert.match(html,/<h3>Card payment on reader<\/h3><p>\$25\.00 · Test payment<\/p><p role="status" aria-live="polite"><b>Waiting for card on Front desk<\/b><\/p>/);
 assert.match(html,/<button type="button" data-reader-payment-cancel>Cancel<\/button>/);assert.doesNotMatch(html,/Try again|receipt/);
 assert.equal(f.waiting(),1,'the next status read is two seconds away');
 await f.tick({...op,last_result:'reader_offline'});html=f.live();
 same(f.calls.at(-1),[`${base}/op`]);
 assert.match(html,/<b>Reader is offline<\/b>/);assert.match(html,/Check that the reader is switched on\./);assert.match(html,/data-reader-payment-cancel/);
 // A read that fails keeps the last known state and tries again.
 await f.tick(()=>{throw new Error('Connection interrupted.');});assert.match(f.live(),/<b>Reader is offline<\/b>/);assert.match(f.live(),/Checking again/);assert.equal(f.waiting(),1);
 await f.tick({...op,last_result:'reader_finishing'});html=f.live();
 assert.match(html,/<b>Finishing on the reader<\/b>/);assert.doesNotMatch(html,/data-reader-payment-cancel|Checking again/,'no Cancel while a card is being approved');
 await f.tick({...op,status:'paid',last_result:'provider_verified',receipt_id:'receipt'});html=f.live();
 assert.match(html,/data-reader-payment="approved"/);assert.match(html,/<b>Approved<\/b>/);
 assert.match(html,/<button type="button" class="primary" data-hosted-copay-receipt="receipt" data-appointment="appt">View \/ print receipt<\/button><button type="button" data-reader-payment-close>Close<\/button>/);
 assert.doesNotMatch(html,/data-reader-payment-cancel|Try again/);
 assert.equal(f.waiting(),0,'a finished payment is not read again');
 const state=c.hostedCopayStateFor('appt');assert.equal(state.items[0].status,'paid');assert.equal(state.items[0].receipt_id,'receipt');
 assert.match(c.hostedCopayMarkup(state),/Card payment verified/,'the appointment panel shows the same verified payment and receipt');
 f.click({readerPaymentClose:''});assert.equal(f.live(),'');
});
test('declined, cancelled, timed out and offline each say so and offer the next step',async()=>{
 for(const [result,text,help] of [['reader_declined','Declined - try another card',null],['reader_cancelled','Cancelled',null],['reader_timed_out','Cancelled','No card was presented in time.'],['reader_offline','Reader is offline','Check that the reader is switched on, then try again.'],['reader_in_use','Reader is in use','Wait for the reader to finish, then try again.'],['reader_unavailable','Payment was not taken','Nothing was charged. Try again.']]){
  const f=fixture(),c=f.ctx;await f.click({readerCopay:'appt'});c.next=op;await f.submit(f.form());
  await f.tick({...op,status:'expired',last_result:result});const html=f.live();
  assert.ok(html.includes(`<b>${text}</b>`),result+': '+html);if(help)assert.ok(html.includes(help),result);
  assert.match(html,/<button type="button" class="primary" data-reader-payment-again>Try again<\/button><button type="button" data-reader-payment-close>Close<\/button>/);
  assert.doesNotMatch(html,/data-reader-payment-cancel|receipt/);assert.equal(f.waiting(),0);
  assert.doesNotMatch(c.hostedCopayMarkup(c.hostedCopayStateFor('appt')),/Checkout expired/,'the panel uses the reader wording too');
  // Try again opens a fresh form with a new request; the closed payment is never reused.
  c.crypto.randomUUID=()=>'second-request';c.items=[{...op,status:'expired',last_result:result}];await f.click({readerPaymentAgain:''});
  assert.match(c.editor,/<form id="reader-copay-form"[^>]*data-request="second-request"/);
 }
 // A payment that started closed (reader offline when it was sent) is shown at once.
 const f=fixture(),c=f.ctx;await f.click({readerCopay:'appt'});c.next={...op,status:'expired',last_result:'reader_offline'};await f.submit(f.form());
 assert.match(f.live(),/<b>Reader is offline<\/b>/);assert.equal(f.waiting(),0);
 const review=fixture();await review.click({readerCopay:'appt'});review.ctx.next={...op,status:'needs_review',last_result:'provider_evidence_needs_review'};await review.submit(review.form());
 assert.match(review.live(),/<b>Payment needs review<\/b>/);assert.doesNotMatch(review.live(),/Try again|data-reader-payment-cancel/);
});
test('Cancel asks the reader to stop and shows what really happened',async()=>{
 let f=fixture(),c=f.ctx;await f.click({readerCopay:'appt'});c.next=op;await f.submit(f.form());
 c.next={...op,status:'expired',last_result:'reader_cancelled'};await f.click({readerPaymentCancel:''});
 same(f.calls.at(-1),[`${base}/op/reader-cancel`,'POST',{}]);
 assert.match(f.live(),/<b>Cancelled<\/b>/);assert.equal(f.waiting(),0);
 // The card was being approved: the payment is not cancelled and its real outcome follows.
 f=fixture();c=f.ctx;await f.click({readerCopay:'appt'});c.next=op;await f.submit(f.form());
 c.next={...op,last_result:'reader_finishing'};await f.click({readerPaymentCancel:''});
 assert.match(f.live(),/<b>Finishing on the reader<\/b>/);assert.equal(f.waiting(),1);
 await f.tick({...op,status:'paid',last_result:'provider_verified',receipt_id:'receipt'});assert.match(f.live(),/<b>Approved<\/b>/);
 // The appointment panel can cancel a waiting payment after the status area is closed.
 f=fixture();c=f.ctx;c.items=[op];await c.loadHostedCopays('appt',true);
 const panel=c.hostedCopayMarkup(c.hostedCopayStateFor('appt'));
 assert.match(panel,/Waiting for card on the reader/);assert.match(panel,/<button type="button" data-cancel-reader-copay="op" data-appointment="appt">Cancel payment<\/button>/);assert.doesNotMatch(panel,/Continue to Stripe checkout|Awaiting card payment/);
 c.next={...op,status:'expired',last_result:'reader_cancelled'};await f.click({cancelReaderCopay:'op',appointment:'appt'});
 same(f.calls.at(-1),[`${base}/op/reader-cancel`,'POST',{}]);assert.equal(c.hostedCopayStateFor('appt').items[0].status,'expired');
});
test('leaving the screen or signing out stops the display, and a lost answer keeps the same request',async()=>{
 let f=fixture(),c=f.ctx;await f.click({readerCopay:'appt'});c.next=op;await f.submit(f.form());
 delete f.nodes['reader-payment-live'];const reads=f.calls.length;await f.tick(op);
 assert.equal(f.calls.length,reads+1);assert.equal(f.waiting(),0,'nothing keeps reading for a screen that is gone');
 f=fixture();c=f.ctx;await f.click({readerCopay:'appt'});c.next=op;await f.submit(f.form());
 c.me={role:'front_desk',user_id:'someone-else'};const before=f.calls.length;const timer=f.timers.filter(t=>!t.cleared).at(-1);await timer.fn();
 assert.equal(f.calls.length,before,'a different staff member never reads the earlier payment');
 f=fixture();c=f.ctx;await f.click({readerCopay:'appt'});c.next=()=>{throw new Error('Synthetic network timeout');};
 await assert.rejects(f.submit(f.form()),/timeout/);const state=c.hostedCopayStateFor('appt');assert.equal(state.uncertain,true);assert.equal(state.retry.reader_id,'tmr_front');
 assert.match(c.hostedCopayMarkup(state),/Send the same \$25\.00 payment to the reader/);
 c.next=op;await f.click({retryHostedCopay:'appt'});const posts=f.calls.filter(call=>call[1]==='POST'&&call[0]===base);
 assert.equal(posts.length,2);assert.equal(posts[0][2].request_id,posts[1][2].request_id,'the retry is the same request, never a second payment');assert.equal(posts[1][2].reader_id,'tmr_front');
});
test('everything staff read is plain and short',async()=>{
 const f=fixture([frontDesk,back]),c=f.ctx;await f.click({readerCopay:'appt'});const pages=[c.editor];
 c.next=op;await f.submit(f.form());pages.push(f.live());
 for(const next of [{...op,last_result:'reader_offline'},{...op,last_result:'reader_finishing'},{...op,status:'paid',receipt_id:'receipt'}]){await f.tick(next);pages.push(f.live());}
 for(const result of ['reader_declined','reader_cancelled','reader_timed_out','reader_offline','reader_in_use','reader_unavailable','reader_failed']){c.readerPaymentLive={operation:{...op,status:'expired',last_result:result}};pages.push(c.readerPaymentMarkup(c.readerPaymentLive));}
 for(const page of pages){const text=visibleText(page);assert.doesNotMatch(text,/terminal|intent|session|server|simulated|connect|sandbox|payload|checkout/i,text);assert.doesNotMatch(text,/[—–]/,text);}
});

(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+(error.stack||error.message));}}if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
