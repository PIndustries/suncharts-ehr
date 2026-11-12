// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/patient-payment-plans.js','utf8');
const patient='11111111-1111-4111-8111-111111111111',request='22222222-2222-4222-8222-222222222222',operation='33333333-3333-4333-8333-333333333333';
function fixture(){
 const nodes={},calls=[],handlers={},identity={tenant_id:'tenant',user_id:'owner',role:'owner'};
 const node=id=>nodes[id]={id,innerHTML:'',isConnected:true,hidden:false,querySelector:selector=>nodes[selector.slice(1)]||null,querySelectorAll:()=>[],replaceChildren(){this.innerHTML='';},scrollIntoView(){},insertAdjacentHTML(_where,html){this.innerHTML+=html;}};
 for(const id of ['patient-billing-memberships','patient-billing-installments','patient-billing-profile-section','installment-plan-review','installment-collection','tools','membership-return','invoice-checkout-return'])node(id);
 const host=node('hub');
 const price={id:'price-one',request_id:'approved-price',name:'Generic membership',amount_cents:5000,currency:'usd',interval:'month',interval_count:1,status:'active'};
 const invoice={invoice_id:'invoice-one',account_id:'account-one',account_version:5,responsibility_cents:3000,patient_credit_cents:2500,remaining_cents:500,currency:'usd',livemode:false,eligible:true,blocked_reason:null,invoice_created_at:'2026-11-11'};
 const plan={id:'plan-one',request_id:request,patient_id:patient,invoice_id:invoice.invoice_id,account_id:invoice.account_id,version:1,status:'active',livemode:false,total_cents:500,remaining_cents:500,autopay:false,installments:[{number:1,due_on:'2026-11-30',amount_cents:250,collected_cents:0,collectible_cents:250,status:'due'},{number:2,due_on:'2026-12-30',amount_cents:250,collected_cents:0,collectible_cents:250,status:'scheduled'}],attempts:[]};
 const s={identity,patientId:patient,tab:'subscriptions',host,planRequest:1,membershipPrices:[price],memberships:[],membershipAvailable:true,catalogCreationAvailable:true,membershipLive:false,eligibleInvoices:[invoice],installmentAvailability:{available:true,livemode:false},installmentPlans:[plan]};
 const ctx={console,URL,URLSearchParams,Date,Intl,Map,Set,Symbol,encodeURIComponent,crypto:{randomUUID:()=>request},me:identity,patientBillingWorkspace:s,document:{addEventListener:(k,v)=>(handlers[k]??=[]).push(v)},$:id=>nodes[id]||null,patientBillingCurrent:value=>value===s&&value.identity===ctx.me&&!s.left,billingCan:()=>true,esc:v=>String(v??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),human:v=>String(v??'').replaceAll('_',' '),money:v=>'$'+(v/100).toFixed(2),dollars:v=>(v/100).toFixed(2),cents:v=>{if(!/^\d+(\.\d{1,2})?$/.test(v))throw Error('invalid amount');return Math.round(Number(v)*100);},date:String,patientBillingProviderDate:String,patientBillingAmount:(v,c)=>'$'+(v/100).toFixed(2),patientBillingCheckoutUrl:v=>{try{const u=new URL(v);return u.protocol==='https:'&&u.host==='checkout.stripe.com'?u.href:null;}catch{return null;}},patientBillingProfileMarkup:()=>'',confirmAction:async()=>true,notice:(...args)=>calls.push(['notice',...args]),run:fn=>ctx.pending=fn(),showTool(){},clearPatientMembershipSignInReturn:()=>calls.push(['clear-membership']),clearInvoiceCheckoutSignInReturn:()=>calls.push(['clear-invoice']),showPatientBillingWorkspace:async options=>{calls.push(['open-hub',options]);return s;}};
 const op={id:operation,request_id:request,patient_id:patient,plan_id:plan.id,account_id:plan.account_id,installment_number:1,amount_cents:250,livemode:false,status:'open',checkout_url:'https://checkout.stripe.com/c/pay/cs_test_synthetic',paid_entry_id:null,refunded_cents:0,unapplied_cents:0,version:1,reason:'Agreed synthetic collection'};
 ctx.api=async(path,method='GET',body,version)=>{calls.push([path,method,body,version]);if(path.includes('/invoice-checkouts/'))return {operation:op};if(path.endsWith('/checkout'))return {plan:{...plan,attempts:[op]},operation:op};if(path.endsWith('/preview'))return {...invoice,installments:body.installments.map((r,i)=>({...r,number:i+1})),autopay:false};if(path.includes('/installment-plans'))return method==='POST'?plan:{items:[plan],eligible_invoices:[invoice],availability:{available:true,livemode:false}};if(path.includes('/membership-prices'))return method==='POST'?{price:{...price,request_id:request}}:{items:[price],creation_available:true};if(path.endsWith('/cancel-at-period-end'))return {patient_id:patient,request_id:request,subscription:{id:'sub_one',cancel_at_period_end:true}};const membership={request_id:request,price,status:'open',session:{url:'https://checkout.stripe.com/c/pay/cs_test_synthetic'},retry_allowed:false,subscription_id:'sub_one',subscription_status:'active'};return path.includes('/memberships/')||method==='POST'?{patient_id:patient,membership}:{patient_id:patient,livemode:false,items:[],creation_available:true};};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 const enrollment={elements:{consent:{checked:true},price_id:{value:price.id}}};
 const collection={dataset:{plan:plan.id,version:'1',number:'1',amount:'250'},elements:{patient_present:{checked:true},reason:{value:op.reason}}};
 return {ctx,s,nodes,calls,handlers,price,invoice,plan,op,enrollment,collection};
}
const mutations=f=>f.calls.filter(call=>call[1]==='POST');
(async()=>{
 let f=fixture(),c=f.ctx;
 const rows=JSON.parse(JSON.stringify(c.proposeInstallmentSchedule(500,3,'2026-01-31')));assert.deepEqual(rows,[{due_on:'2026-01-31',amount_cents:167},{due_on:'2026-02-28',amount_cents:167},{due_on:'2026-03-31',amount_cents:166}]);assert.equal(rows.reduce((n,r)=>n+r.amount_cents,0),500);
 for(const args of [[50,2,'2026-01-01'],[500,2,'2026-02-30'],[500,25,'2026-01-01']])assert.throws(()=>c.proposeInstallmentSchedule(...args));
 f.enrollment.elements.consent.checked=false;await c.createPatientMembership(f.s,f.enrollment);assert.equal(mutations(f).length,0);
 f.enrollment.elements.consent.checked=true;f.s.memberships=[{request_id:'existing',price:f.price,status:'active'}];await assert.rejects(c.createPatientMembership(f.s,f.enrollment),/existing membership/);assert.equal(mutations(f).length,0);
 f.s.memberships=[];await c.createPatientMembership(f.s,f.enrollment);assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0][2].price_id,'price-one');assert.equal(mutations(f)[0][2].consent,true);assert.match(f.nodes['patient-billing-memberships'].innerHTML,/Continue secure membership checkout/);
 // Ambiguous creation retains one immutable request; only explicit same-request retry is allowed.
 f=fixture();c=f.ctx;const actual=c.api;c.api=async(path,method,body)=>{if(method==='POST'){f.calls.push([path,method,body]);throw Error('response lost');}return actual(path,method,body);};await c.createPatientMembership(f.s,f.enrollment);const pending=c.membershipCurrentRequest(f.s);assert.equal(pending.status,'unknown');await c.createPatientMembership(f.s,f.enrollment);assert.equal(mutations(f).length,1);c.api=actual;await c.createPatientMembership(f.s,null,pending);assert.equal(mutations(f).length,2);assert.equal(mutations(f)[0][2].request_id,mutations(f)[1][2].request_id);
 // A dialog confirmed after changing patient/session never cancels the prior membership.
 f=fixture();c=f.ctx;let finish;f.s.memberships=[{request_id:request,price:f.price,status:'active',subscription_status:'active',subscription_id:'sub_one',cancellation_available:true}];c.confirmAction=()=>new Promise(r=>finish=r);const cancel=c.cancelPatientMembership(f.s,request);f.s.left=true;finish(true);await cancel;assert.equal(mutations(f).length,0);
 // Cancellation is offered only when the server verified the local patient/subscription binding.
 f=fixture();c=f.ctx;f.s.memberships=[{request_id:request,price:f.price,status:'active',subscription_status:'active',subscription_id:'sub_one'}];
 assert.doesNotMatch(c.patientMembershipRows(f.s),/data-membership-cancel/);await c.cancelPatientMembership(f.s,request);assert.equal(mutations(f).length,0);
 f.s.memberships[0].cancellation_available=true;assert.match(c.patientMembershipRows(f.s),/data-membership-cancel/);
 // Finite schedule preview uses only the reviewed invoice, does not create a plan or checkout.
 f=fixture();c=f.ctx;const schedule=[{due_on:'2026-11-30',amount_cents:250},{due_on:'2026-12-30',amount_cents:250}];
 const form={dataset:{invoice:'invoice-one'},elements:{invoice_id:{value:'invoice-one'}},querySelectorAll:()=>schedule.map(row=>({querySelector:q=>({value:q.includes('due_on')?row.due_on:(row.amount_cents/100).toFixed(2)})}))};await c.previewInstallmentPlan(f.s,form);assert.equal(mutations(f).length,1);assert.match(mutations(f)[0][0],/\/preview$/);assert.equal(mutations(f)[0][2].livemode,false);assert.match(f.nodes['installment-plan-review'].innerHTML,/No automatic card charges/);
 const confirm={elements:{consent:{checked:true},reason:{value:'Patient reviewed finite schedule'}}};await c.createInstallmentPlan(f.s,confirm,false);assert.equal(mutations(f).length,2);assert.equal(mutations(f)[1][3],5,'optimistic account version comes from server preview');assert.equal(mutations(f)[1][2].request_id,request);assert.ok(!f.calls.some(call=>String(call[0]).endsWith('/checkout')));
 // Creating the plan never collects; collecting requires fresh patient-present consent.
 f=fixture();c=f.ctx;f.collection.elements.patient_present.checked=false;await c.createInstallmentCheckout(f.s,f.collection);assert.equal(mutations(f).length,0);f.collection.elements.patient_present.checked=true;await c.createInstallmentCheckout(f.s,f.collection);assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0][3],1);assert.equal(mutations(f)[0][2].patient_present,true);assert.equal(mutations(f)[0][2].amount_cents,250,'collection sends the exact amount the patient reviewed');assert.match(f.nodes['patient-billing-installments'].innerHTML,/No patient ledger capture is confirmed/);
 // Return refresh can retrieve only the existing operation, never create Checkout.
 f=fixture();c=f.ctx;await c.openInvoiceCheckoutReturn(operation);assert.deepEqual(f.calls.filter(call=>call[0].startsWith('/api/')).map(call=>[call[1],call[0]]),[['GET','/api/v1/billing/invoice-checkouts/'+operation],['POST','/api/v1/billing/invoice-checkouts/'+operation+'/refresh']]);assert.equal(f.calls.find(call=>call[0]==='open-hub')[1].patientId,patient);assert.equal(f.calls.find(call=>call[0]==='open-hub')[1].planId,'plan-one');assert.equal(f.op.paid_entry_id,null);
 f=fixture();c=f.ctx;await c.openPatientMembershipReturn(request);assert.equal(mutations(f).length,0);assert.equal(f.calls.find(call=>call[0]==='open-hub')[1].tab,'subscriptions');
 f=fixture();c=f.ctx;c.api=()=>new Promise(r=>finish=r);const returning=c.openInvoiceCheckoutReturn(operation);c.me={tenant_id:'other',role:'owner'};finish({operation:f.op});await returning;assert.ok(!f.calls.some(call=>call[0]==='open-hub'));assert.equal(mutations(f).length,0);
 // Drafts are memory-only, scoped to the patient and authenticated identity; consent is never restored.
 f=fixture();c=f.ctx;
 const makeDraft=(kind='membership-price',id='membership-price-form')=>{
  const fields=[{name:'reason',value:'',type:'textarea'},{name:'approved',value:'on',type:'checkbox',checked:false}];
  return {id,dataset:{patientPlanDraft:kind},querySelectorAll:()=>fields,fields};
 };
 let draft=makeDraft();f.s.host.querySelectorAll=()=>[draft];c.restorePatientPlanDraft(f.s,draft);assert.equal(c.patientPaymentPlansHaveDrafts(),false);
 draft.fields[0].value='Retained synthetic approval';draft.fields[1].checked=true;c.capturePatientPaymentPlanDrafts();assert.equal(c.patientPaymentPlansHaveDrafts(),true);
 draft=makeDraft();c.restorePatientPlanDraft(f.s,draft);assert.equal(draft.fields[0].value,'Retained synthetic approval');assert.equal(draft.fields[1].checked,false);
 const priorPatient=f.s.patientId;f.s.patientId='44444444-4444-4444-8444-444444444444';draft=makeDraft();c.restorePatientPlanDraft(f.s,draft);assert.equal(draft.fields[0].value,'');f.s.patientId=priorPatient;
 c.me={...c.me,user_id:'different-session'};assert.equal(c.patientPaymentPlansHaveDrafts(),false);
 // A successful collection retires exactly submitted text, including a same-host replacement form;
 // later typing is retained for explicit review, never silently re-submitted.
 for(const editWhileSaving of [false,true]){
  f=fixture();c=f.ctx;const fields=[{name:'reason',value:'',type:'text'},{name:'patient_present',value:'on',type:'checkbox',checked:false}];
  const form={...f.collection,dataset:{...f.collection.dataset,patientPlanDraft:'installment-checkout:plan-one:1'},querySelectorAll:()=>fields};form.elements={reason:fields[0],patient_present:fields[1]};
  let visible=form;f.s.host.querySelectorAll=()=>[visible];c.restorePatientPlanDraft(f.s,form);fields[0].value='Original agreed collection';fields[1].checked=true;c.capturePatientPaymentPlanDrafts();
  let complete;const original=c.api;c.api=(path,...args)=>path.endsWith('/checkout')?new Promise(resolve=>complete=resolve):original(path,...args);
  const pending=c.createInstallmentCheckout(f.s,form);const replacementFields=fields.map(field=>({...field,value:field.name==='reason'?'':field.value,checked:false}));visible={...form,querySelectorAll:()=>replacementFields,elements:{reason:replacementFields[0],patient_present:replacementFields[1]}};c.restorePatientPlanDraft(f.s,visible);if(editWhileSaving)replacementFields[0].value='Newer unsubmitted reason';complete({plan:{...f.plan,attempts:[f.op]},operation:f.op});await pending;
  c.capturePatientPaymentPlanDrafts();assert.equal(c.patientPaymentPlansHaveDrafts(),editWhileSaving,'only later unsaved typing remains after successful collection');
 }
 // Every section read has its own generation, so old financial status cannot replace a newer refresh.
 for(const section of ['memberships','installments']){
  f=fixture();c=f.ctx;const waiting=[],original=c.api;c.api=(path,...args)=>path.endsWith(section==='memberships'?'/memberships':'/installment-plans')?new Promise(resolve=>waiting.push(resolve)):original(path,...args);
  const loader=section==='memberships'?c.loadPatientMemberships:c.loadPatientInstallments;
  const older=loader(f.s,1),newer=loader(f.s,1);
  if(section==='memberships'){
   waiting[1]({patient_id:patient,livemode:false,items:[{request_id:request,price:f.price,status:'active'}],creation_available:true});await newer;
   waiting[0]({patient_id:patient,livemode:false,items:[{request_id:request,price:f.price,status:'open'}],creation_available:true});await older;assert.equal(f.s.memberships[0].status,'active');
  }else{
   waiting[1]({items:[{...f.plan,remaining_cents:250}],eligible_invoices:[],availability:{available:true,livemode:false}});await newer;
   waiting[0]({items:[f.plan],eligible_invoices:[],availability:{available:true,livemode:false}});await older;assert.equal(f.s.installmentPlans[0].remaining_cents,250);
  }
 }
 // Per-operation status reads must not undo a newer section result or cancellation.
 f=fixture();c=f.ctx;let oldStatus;const statusApi=c.api;
 c.api=(path,...args)=>path==='/api/v1/billing/memberships/'+request?new Promise(resolve=>oldStatus=resolve):path.endsWith('/memberships')?Promise.resolve({patient_id:patient,livemode:false,items:[{request_id:request,price:f.price,status:'active',cancel_at_period_end:true}],creation_available:true}):statusApi(path,...args);
 const staleStatus=c.refreshPatientMembership(f.s,request);await c.loadPatientMemberships(f.s,1);
 oldStatus({patient_id:patient,membership:{request_id:request,price:f.price,status:'active',cancel_at_period_end:false}});await staleStatus;
 assert.equal(f.s.memberships[0].cancel_at_period_end,true,'older per-operation GET cannot undo newer cancellation evidence');
 for(const read of ['refreshPatientMembership','refreshMembershipOperation','refreshMembershipPrice']){
  f=fixture();c=f.ctx;let resolveRead;c.api=()=>new Promise(resolve=>resolveRead=resolve);const pendingRead=c[read](f.s,request);f.s.planRequest++;
  resolveRead({patient_id:patient,membership:{request_id:request,price:f.price,status:'open'},price:{...f.price,request_id:request}});await pendingRead;
  assert.equal(f.s.memberships.length,0,'a replaced subscriptions section ignores '+read);
 }
 // Reload discovery uses the server's original pending operation, never a replacement UUID.
 f=fixture();c=f.ctx;const originalPending=c.api;
 c.api=async(path,method='GET',body,...rest)=>{
  if(path.endsWith('/memberships')&&method==='GET')return {patient_id:patient,livemode:false,items:[],creation_available:true,pending_operations:[{kind:'membership',request_id:request,status:'creating',retry_allowed:true,retry_safe_until:new Date(Date.now()+60000).toISOString(),request:{request_id:request,price_id:f.price.id,consent:true}}]};
  return originalPending(path,method,body,...rest);
 };
 await c.loadPatientMemberships(f.s,1);assert.match(f.nodes['patient-billing-memberships'].innerHTML,/Check original request/);await c.retryMembershipOperation(f.s,request);assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0][2].request_id,request);
 // A refreshed server response can forbid a retry even while the local time window remains open.
 f=fixture();c=f.ctx;const refused={request_id:request,price:f.price,status:'needs_review',input:{request_id:request,price_id:f.price.id,consent:true},retry_allowed:false,retry_safe_until:new Date(Date.now()+60000).toISOString()};
 c.membershipSession();vm.runInContext('membershipRequests',c).set(patient,refused);await c.createPatientMembership(f.s,null,refused);assert.equal(mutations(f).length,0);

 console.log('PASS patient plans: exact minor-unit schedule, explicit recurring/patient-present consent, duplicate guard, stable request retry, invoice-version preview/create, read-only membership return and existing-only installment refresh');
})().catch(error=>{console.error(error);process.exitCode=1;});
