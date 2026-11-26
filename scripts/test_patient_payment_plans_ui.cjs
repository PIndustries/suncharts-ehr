// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
process.env.TZ='America/Chicago';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/patient-payment-plans.js','utf8');
const patient='11111111-1111-4111-8111-111111111111',request='22222222-2222-4222-8222-222222222222',operation='33333333-3333-4333-8333-333333333333';
function fixture(){
 const nodes={},calls=[],handlers={},identity={tenant_id:'tenant',user_id:'owner',role:'owner'};
 const clock=class extends Date{constructor(...args){super(...(args.length?args:['2026-11-12T02:23:00Z']));}static now(){return new Date('2026-11-12T02:23:00Z').getTime();}};
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
 ctx.Date=clock;
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
 // At Chicago Nov11 evening the unchanged server rule already uses Nov12 UTC.
 f=fixture();c=f.ctx;
 assert.equal(c.installmentDueDateBounds().earliest,'2026-11-12');
 assert.match(c.installmentPlanForm(f.s),/min="2026-11-12"/);
 assert.match(c.installmentPlanForm(f.s),/today in UTC.*tomorrow in your local time/);
 let firstDue='2026-11-11';const localSchedule={dataset:{invoice:f.invoice.invoice_id},elements:{invoice_id:{value:f.invoice.invoice_id}},querySelectorAll:()=>[{querySelector:q=>({value:q.includes('due_on')?firstDue:'2.50'})},{querySelector:q=>({value:q.includes('due_on')?'2026-12-12':'2.50'})}]};
 await assert.rejects(c.previewInstallmentPlan(f.s,localSchedule),/on or after 2026-11-12.*UTC/);assert.equal(mutations(f).length,0);assert.equal(firstDue,'2026-11-11','invalid dates are explained, never silently changed');
 firstDue='2026-11-12';await c.previewInstallmentPlan(f.s,localSchedule);assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0][2].installments[0].due_on,'2026-11-12');
 const earliestForm={elements:{invoice_id:{value:f.invoice.invoice_id},count:{value:'2'},first_due:{value:'2026-11-11'}}};
 assert.throws(()=>c.divideInstallmentSchedule(f.s,earliestForm),/on or after 2026-11-12.*UTC/);
 assert.throws(()=>c.validateInstallmentDueDates([{due_on:'2031-11-13'}]),/five-year scheduling limit/);
 // An invoice with an existing immutable plan is not a missing responsibility review.
 f.s.eligibleInvoices=[{...f.invoice,eligible:false,existing_plan_id:f.plan.id}];
 assert.match(c.installmentPlanForm(f.s),/Every billed statement already has a payment plan/);
 assert.doesNotMatch(c.installmentPlanForm(f.s),/A payment plan is made from a statement|id="installment-preview-form"/);
 f.s.eligibleInvoices.push({...f.invoice,invoice_id:'another-invoice'});assert.match(c.installmentPlanForm(f.s),/id="installment-preview-form"/);
 f.s.eligibleInvoices=[];f.s.installmentPlans=[];assert.match(c.installmentPlanForm(f.s),/A payment plan is made from a statement for an encounter that has been billed\./);assert.match(c.installmentPlanForm(f.s),/<button type="button" data-hub-tab="overview">Go to billing<\/button>/);
 // Creating the plan never collects; collecting requires fresh patient-present consent.
 f=fixture();c=f.ctx;f.collection.elements.patient_present.checked=false;await c.createInstallmentCheckout(f.s,f.collection);assert.equal(mutations(f).length,0);f.collection.elements.patient_present.checked=true;await c.createInstallmentCheckout(f.s,f.collection);assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0][3],1);assert.equal(mutations(f)[0][2].patient_present,true);assert.equal(mutations(f)[0][2].amount_cents,250,'collection sends the exact amount the patient reviewed');assert.match(f.nodes['patient-billing-installments'].innerHTML,/No patient ledger capture is confirmed/);
 // Return refresh can retrieve only the existing operation, never create Checkout.
 f=fixture();c=f.ctx;await c.openInvoiceCheckoutReturn(operation);assert.deepEqual(f.calls.filter(call=>call[0].startsWith('/api/')).map(call=>[call[1],call[0]]),[['GET','/api/v1/billing/invoice-checkouts/'+operation],['POST','/api/v1/billing/invoice-checkouts/'+operation+'/refresh']]);assert.equal(f.calls.find(call=>call[0]==='open-hub')[1].patientId,patient);assert.equal(f.calls.find(call=>call[0]==='open-hub')[1].planId,'plan-one');assert.equal(f.op.paid_entry_id,null);
 f=fixture();c=f.ctx;await c.openPatientMembershipReturn(request);assert.equal(mutations(f).length,0);assert.equal(f.calls.find(call=>call[0]==='open-hub')[1].tab,'subscriptions');
 // A successful return excludes an already-enrolled price without claiming the catalog is empty.
 f=fixture();c=f.ctx;const returnApi=c.api,activeMembership={request_id:request,price:f.price,status:'active',subscription_status:'active',subscription_id:'sub_one'};
 c.api=async(path,...args)=>path==='/api/v1/billing/memberships/'+request?{patient_id:patient,membership:activeMembership}:path.endsWith('/memberships')?{patient_id:patient,livemode:false,items:[activeMembership],creation_available:true}:returnApi(path,...args);
 c.showPatientBillingWorkspace=async()=>{await c.loadPatientMemberships(f.s,1);return f.s;};
 await c.openPatientMembershipReturn(request);
 assert.match(f.nodes['patient-billing-memberships'].innerHTML,/already has every membership the practice offers/);
 assert.doesNotMatch(f.nodes['patient-billing-memberships'].innerHTML,/No membership prices have been added|id="patient-membership-form"/);
 await assert.rejects(c.createPatientMembership(f.s,f.enrollment),/existing membership/);assert.equal(mutations(f).length,0);
 // Unknown, paginated, failed and confirmed-empty catalog states remain distinct.
 f=fixture();c=f.ctx;delete f.s.membershipPrices;
 assert.match(c.membershipSelectionForm(f.s),/have not loaded yet/);
 assert.doesNotMatch(c.membershipSelectionForm(f.s),/No membership prices have been added/);
 f.s.membershipPrices=[];assert.match(c.membershipSelectionForm(f.s),/No membership prices have been added/);
 f.s.membershipPricesNext='next';assert.match(c.membershipSelectionForm(f.s),/No other membership prices/);
 assert.doesNotMatch(c.membershipSelectionForm(f.s),/No membership prices have been added/);
 f.s.membershipPrices=[f.price];f.s.memberships=[{...activeMembership,status:'canceled'}];f.s.membershipPricesNext=null;
 assert.match(c.membershipSelectionForm(f.s),/id="patient-membership-form"/);
 const malformedApi=c.api;c.api=(path,...args)=>path==='/api/v1/billing/membership-prices'?Promise.resolve({creation_available:true}):malformedApi(path,...args);
 await c.loadPatientMemberships(f.s,1);assert.match(f.nodes['patient-billing-memberships'].innerHTML,/could not be verified/);
 assert.doesNotMatch(f.nodes['patient-billing-memberships'].innerHTML,/No membership prices have been added/);
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
 for(const read of ['refreshPatientMembership','refreshMembershipOperation']){
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

 // Patient tab: two clear cards, one button each, and every unavailable state carries its fixing button.
 f=fixture();c=f.ctx;c.renderPatientMembershipPanel(f.s);let panel=f.nodes['patient-billing-memberships'].innerHTML;
 assert.match(panel,/<h3>Memberships<\/h3>/);assert.match(panel,/<button type="button" class="primary" data-start-membership>Start membership<\/button>/);assert.equal((panel.match(/class="primary"/g)||[]).length,1);
 assert.doesNotMatch(panel,/<details|membership-price-form|Approve a practice membership price|<form/,'no price form and no inline form on the patient tab');
 f.s.membershipAvailable=false;assert.match(c.membershipSelectionForm(f.s),/Card payments are not set up yet[\s\S]*data-payment-settings>Set up card payments<\/button>/);
 f.s.identity.role='front_desk';assert.doesNotMatch(c.membershipSelectionForm(f.s),/<button/);assert.match(c.membershipSelectionForm(f.s),/Ask the practice owner to set up card payments/);
 f.s.membershipAvailable=true;f.s.membershipPrices=[];assert.match(c.membershipSelectionForm(f.s),/Ask the practice owner to add a membership price/);assert.doesNotMatch(c.membershipSelectionForm(f.s),/data-open-membership-prices/);
 f.s.identity.role='owner';assert.match(c.membershipSelectionForm(f.s),/No membership prices have been added yet\.[\s\S]*data-open-membership-prices>Add a membership price<\/button>/);
 c.renderPatientMembershipPanel(f.s);panel=f.nodes['patient-billing-memberships'].innerHTML;assert.doesNotMatch(panel,/data-start-membership/);assert.match(panel,/data-open-membership-prices/);
 f.s.membershipPrices=[f.price];f.s.memberships=[{request_id:'existing',price:f.price,status:'active',subscription_status:'active',current_period_end:'2026-12-01T00:00:00Z'}];c.renderPatientMembershipPanel(f.s);panel=f.nodes['patient-billing-memberships'].innerHTML;
 assert.match(panel,/already has every membership the practice offers/);assert.doesNotMatch(panel,/data-start-membership/);assert.match(panel,/Generic membership/);assert.match(panel,/Active/);
 // The enrolment form is still the same form with the consent box, and opens only when enrolment is possible.
 f=fixture();c=f.ctx;assert.match(c.membershipSelectionForm(f.s),/id="patient-membership-form"[\s\S]*name="consent" type="checkbox" required/);
 // Payment plans card.
 f=fixture();c=f.ctx;c.renderPatientInstallments(f.s);panel=f.nodes['patient-billing-installments'].innerHTML;
 assert.match(panel,/<h3>Payment plans<\/h3>/);assert.match(panel,/<button type="button" class="primary" data-start-payment-plan-sheet>Start payment plan<\/button>/);assert.doesNotMatch(panel,/<details|<form id="installment-preview-form"|Visit payment plan/);
 assert.match(panel,/\$5\.00 in 2 payments · 0 paid · \$5\.00 left · Next due 2026-11-30/);assert.match(panel,/data-installment-collect="plan-one" data-installment-number="1">Collect payment<\/button>/);
 f.s.eligibleInvoices=[];f.s.installmentPlans=[];c.renderPatientInstallments(f.s);panel=f.nodes['patient-billing-installments'].innerHTML;
 assert.doesNotMatch(panel,/data-start-payment-plan-sheet/);assert.match(panel,/A payment plan is made from a statement for an encounter that has been billed\.[\s\S]*data-hub-tab="overview">Go to billing<\/button>/);
 f.s.installmentAvailability={available:false};c.renderPatientInstallments(f.s);panel=f.nodes['patient-billing-installments'].innerHTML;assert.match(panel,/Card payments are not set up yet[\s\S]*data-payment-settings>Set up card payments<\/button>/);
 f.s.identity.role='front_desk';c.renderPatientInstallments(f.s);assert.match(f.nodes['patient-billing-installments'].innerHTML,/Ask the practice owner to set up card payments/);
 // Start payment plan sheet holds the same create-plan form; the scope check accepts it and its schedule review lands in the sheet.
 f=fixture();c=f.ctx;{const holder={innerHTML:'',querySelector:sel=>sel==='#installment-plan-review'?review:sel==='#installment-preview-form'?null:null},review={id:'r'};
  let opened=null;c.document.createElement=()=>holder;c.sheetOpen=(title,node)=>{opened={title,node};return sheet;};const sheet={isConnected:true,querySelector:sel=>sel==='#installment-plan-review'?review:null,contains:()=>true};
  const dialog=c.openStartPaymentPlanSheet(f.s);assert.equal(dialog,sheet);assert.equal(opened.title,'Start payment plan');assert.match(holder.innerHTML,/id="installment-preview-form"[\s\S]*name="invoice_id"[\s\S]*name="count"[\s\S]*name="first_due"[\s\S]*data-installment-divide>Propose schedule/);assert.match(holder.innerHTML,/id="installment-plan-review"/);
  assert.equal(c.planReviewHost(f.s),review,'the review shows inside the sheet while it is open');
  const inSheet={closest:sel=>sel==='dialog'?sheet:null};assert.equal(c.patientPlanInScope(f.s,inSheet),true);assert.equal(c.patientPlanInScope(f.s,{closest:()=>null}),false);
  f.s.eligibleInvoices=[];assert.equal(c.openStartPaymentPlanSheet(f.s),null,'no sheet when no statement is eligible');}
 // Practice administration > Memberships: list, owner-only add button, payment-settings button when unavailable, same posted body.
 const adminTarget=(x)=>{x.nodes['membership-prices-admin']={innerHTML:''};return {innerHTML:'',querySelector:sel=>x.nodes[sel.slice(1)]||null};};
 f=fixture();c=f.ctx;let target=adminTarget(f);c.renderMembershipPricesAdmin(target);await new Promise(resolve=>setImmediate(resolve));
 let admin=f.nodes['membership-prices-admin'].innerHTML;
 assert.match(target.innerHTML,/<h2>Practice administration<\/h2>/);assert.match(admin,/Generic membership[\s\S]*\$50\.00[\s\S]*Every month[\s\S]*Active/);assert.match(admin,/<button type="button" class="primary" data-membership-price-new>Add membership price<\/button>/);
 assert.match(c.practiceAdminExtraTabs('memberships'),/data-admin-tab="memberships" aria-pressed="true">Memberships/);assert.equal(c.practiceAdminExtraRender('staff',target),false);
 f.s.identity.role='front_desk';c.paintMembershipPricesAdmin(target);admin=f.nodes['membership-prices-admin'].innerHTML;assert.match(admin,/Generic membership/);assert.doesNotMatch(admin,/data-membership-price-new|data-payment-settings/,'other roles see the list without the button');
 f=fixture();c=f.ctx;const priceApi=c.api;c.api=async(path,...args)=>path.startsWith('/api/v1/billing/membership-prices')&&(args[0]||'GET')==='GET'?{items:[],creation_available:false}:priceApi(path,...args);target=adminTarget(f);c.renderMembershipPricesAdmin(target);await new Promise(resolve=>setImmediate(resolve));
 admin=f.nodes['membership-prices-admin'].innerHTML;assert.match(admin,/Card payments must be set up before a membership price can be added\.[\s\S]*data-payment-settings>Set up card payments<\/button>/);assert.doesNotMatch(admin,/data-membership-price-new/);assert.match(admin,/No membership prices yet/);
 f=fixture();c=f.ctx;target=adminTarget(f);c.renderMembershipPricesAdmin(target);await new Promise(resolve=>setImmediate(resolve));
 const priceForm={elements:{approved:{checked:false},name:{value:' Gold plan '},amount:{value:'50.00'},interval:{value:'month'},interval_count:{value:'1'},approval_reason:{value:'Approved by the owner'}}};
 await c.approveMembershipPrice(priceForm);assert.equal(mutations(f).length,0,'approval box is required');
 priceForm.elements.approved.checked=true;await c.approveMembershipPrice(priceForm);assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0][0],'/api/v1/billing/membership-prices');
 assert.deepEqual(JSON.parse(JSON.stringify(mutations(f)[0][2])),{request_id:request,name:'Gold plan',amount_cents:5000,currency:'usd',interval:'month',interval_count:1,approved:true,approval_reason:'Approved by the owner'});
 f.ctx.me.role='front_desk';await c.approveMembershipPrice(priceForm);assert.equal(mutations(f).length,1,'only a practice owner can add a price');
 assert.doesNotMatch(source,/Approve a practice membership price/);

 // Cancel plan: quiet button on active plans only, for people who may create plans.
 f=fixture();c=f.ctx;
 let card=c.installmentPlanMarkup(f.plan,f.s);
 assert.match(card,/<button type="button" data-installment-cancel-plan="plan-one">Cancel plan<\/button>/);assert.doesNotMatch(card,/data-installment-cancel-plan="plan-one" class|class="primary"[^>]*data-installment-cancel-plan/);
 for(const status of ['complete','cancelled'])assert.doesNotMatch(c.installmentPlanMarkup({...f.plan,status},f.s),/data-installment-cancel-plan/,status+' plan has no cancel button');
 c.billingCan=()=>false;assert.doesNotMatch(c.installmentPlanMarkup(f.plan,f.s),/data-installment-cancel-plan/,'no button without permission');c.billingCan=()=>true;
 // The sheet: title, one plain line, required reason, two buttons.
 {const holder={innerHTML:'',querySelector:()=>null};let opened=null;const sheet={isConnected:true};
  c.document.createElement=()=>holder;c.sheetOpen=(title,node)=>{opened={title,node};return sheet;};
  assert.equal(c.openCancelPlanSheet(f.s,'plan-one'),sheet);assert.equal(opened.title,'Cancel payment plan');
  assert.match(holder.innerHTML,/Payments already taken stay as they are\. Nothing is refunded\. What is left stays owed on the encounter\./);
  assert.match(holder.innerHTML,/<label>Reason<input name="reason" maxlength="1000" autocomplete="off" required><\/label>/);
  assert.match(holder.innerHTML,/<button type="submit">Cancel this plan<\/button>/);assert.match(holder.innerHTML,/data-installment-cancel-keep>Keep plan<\/button>/);
  assert.doesNotMatch(holder.innerHTML,/class="primary"/);assert.doesNotMatch(holder.innerHTML,/visit|Stripe/i);
  f.s.installmentPlans=[{...f.plan,status:'cancelled'}];assert.equal(c.openCancelPlanSheet(f.s,'plan-one'),null,'no sheet for a cancelled plan');
  c.billingCan=()=>false;f.s.installmentPlans=[f.plan];assert.equal(c.openCancelPlanSheet(f.s,'plan-one'),null,'no sheet without permission');c.billingCan=()=>true;
  // Keep plan closes the sheet and sends nothing.
  let closed=false;c.sheetClose=()=>{closed=true;};f.s.plansSheet=sheet;const before=f.calls.length;
  for(const handler of f.handlers.click||[])handler({target:{closest:sel=>sel==='button'?{dataset:{},hasAttribute:name=>name==='data-installment-cancel-keep',closest:()=>sheet}:null}});
  assert.equal(closed,true);assert.equal(f.calls.length,before);}
 // Submitting needs a reason, posts it with the plan version, closes the sheet, reloads and shows the notice.
 f=fixture();c=f.ctx;f.s.installmentPlans=[{...f.plan,version:7}];{
  let closed=0;c.sheetClose=()=>{closed++;};f.s.plansSheet={isConnected:true};
  const form={dataset:{plan:'plan-one'},elements:{reason:{value:'   '}}};
  await assert.rejects(c.cancelInstallmentPlan(f.s,form),/Enter a reason/);assert.equal(mutations(f).length,0);
  form.elements.reason.value='  Patient moved away  ';
  const cancelled={...f.plan,version:8,status:'cancelled',cancelled_at:'2026-11-12T10:00:00Z',cancel_reason:'Patient moved away',installments:f.plan.installments.map(row=>({...row,status:'cancelled'}))};
  const base=c.api;c.api=async(path,method='GET',body,version)=>path.endsWith('/cancel')?(f.calls.push([path,method,body,version]),cancelled):base(path,method,body,version);
  await c.cancelInstallmentPlan(f.s,form);
  assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0][0],`/api/v1/billing/patients/${patient}/installment-plans/plan-one/cancel`);
  assert.deepEqual(JSON.parse(JSON.stringify(mutations(f)[0][2])),{reason:'Patient moved away'});assert.equal(mutations(f)[0][3],7);
  assert.equal(closed,1);assert.ok(f.calls.some(call=>call[0]==='notice'&&call[1]==='Payment plan cancelled.'&&!call[2]));
  assert.ok(f.calls.some(call=>call[0]===`/api/v1/billing/patients/${patient}/installment-plans`&&call[1]==='GET'),'plans are reloaded');}
 // A refusal is thrown to the sheet (shown as a line at the top of it) and nothing else changes.
 f=fixture();c=f.ctx;{
  const base=c.api;c.api=async(path,...rest)=>{if(path.endsWith('/cancel'))throw Error('A payment for this plan is still in progress. Finish or cancel that payment first.');return base(path,...rest);};
  f.s.plansSheet={isConnected:true};let closed=0;c.sheetClose=()=>{closed++;};
  await assert.rejects(c.cancelInstallmentPlan(f.s,{dataset:{plan:'plan-one'},elements:{reason:{value:'Patient asked'}}}),/still in progress/);
  assert.equal(closed,0);assert.ok(!f.calls.some(call=>call[0]==='notice'));}
 // A cancelled card: status, date and escaped reason, what was paid, no collect or cancel buttons.
 f=fixture();c=f.ctx;{
  const cancelled={...f.plan,status:'cancelled',cancelled_at:'2026-11-12T10:00:00Z',cancel_reason:'<b>Moved</b> away',total_cents:500,remaining_cents:250,installments:[{number:1,due_on:'2026-11-30',amount_cents:250,collected_cents:250,collectible_cents:0,status:'complete'},{number:2,due_on:'2026-12-30',amount_cents:250,collected_cents:0,collectible_cents:250,status:'cancelled'}]};
  card=c.installmentPlanMarkup(cancelled,f.s);
  assert.match(card,/<span class="pill">Cancelled<\/span>/);assert.match(card,/Cancelled on 2026-11-12T10:00:00Z\. Reason: &lt;b&gt;Moved&lt;\/b&gt; away/);assert.doesNotMatch(card,/<b>Moved<\/b>/);
  assert.match(card,/\$5\.00 in 2 payments · 1 paid · \$2\.50 still owed/);assert.doesNotMatch(card,/Next due/);
  assert.doesNotMatch(card,/data-installment-collect|data-installment-cancel-plan|Collect payment|Cancel plan/);
  f.s.installmentPlans=[cancelled];c.renderPatientInstallments(f.s);assert.match(f.nodes['patient-billing-installments'].innerHTML,/Cancelled/);}
 // Retire a membership price: quiet button for the owner on rows that are not retired.
 f=fixture();c=f.ctx;{
  const st=c.membershipAdminState();st.available=true;
  st.prices=[{...f.price,id:'price-one'},{...f.price,id:'price-two',status:'retired',enrolment_open:false,retired_at:'2026-11-10T00:00:00Z'}];
  const rows=c.membershipPriceRows(st.prices,true);
  assert.match(rows,/<button type="button" data-membership-price-retire="price-one">Retire<\/button>/);
  assert.equal((rows.match(/data-membership-price-retire=/g)||[]).length,1,'a retired row has no button');
  assert.match(rows,/Retired 2026-11-10T00:00:00Z/);
  assert.doesNotMatch(c.membershipPriceRows(st.prices,false),/data-membership-price-retire/);
  assert.match(c.membershipPricesAdminMarkup(st),/data-membership-price-retire="price-one"/);
  c.me.role='front_desk';assert.doesNotMatch(c.membershipPricesAdminMarkup(st),/data-membership-price-retire/,'owner only');
  assert.equal(c.openRetirePriceSheet('price-one'),null,'no sheet for anyone but the owner');c.me.role='owner';
  c.billingCan=()=>false;assert.doesNotMatch(c.membershipPricesAdminMarkup(st),/data-membership-price-retire/);c.billingCan=()=>true;
  // The sheet: title, one plain line, two buttons.
  const holder={innerHTML:'',querySelector:()=>null};let opened=null;const sheet={isConnected:true};
  c.document.createElement=()=>holder;c.sheetOpen=(title,node)=>{opened={title,node};return sheet;};
  assert.equal(c.openRetirePriceSheet('price-two'),null,'no sheet for a retired price');
  assert.equal(c.openRetirePriceSheet('price-one'),sheet);assert.equal(opened.title,'Retire membership price');
  assert.match(holder.innerHTML,/Nobody new can be started on this price\. Patients already on it keep their membership\./);
  assert.match(holder.innerHTML,/<button type="submit">Retire this price<\/button>/);assert.match(holder.innerHTML,/data-membership-price-retire-keep>Keep price<\/button>/);
  assert.doesNotMatch(holder.innerHTML,/Stripe/i);
  // One request id per price until it succeeds: a failed attempt and the repeat click send the same id.
  let n=0;c.crypto={randomUUID:()=>'retire-'+(++n)};
  let fail=true;const base=c.api;
  c.api=async(path,method='GET',body)=>{if(path.endsWith('/retire')){f.calls.push([path,method,body]);if(fail)throw Error('The result is not known yet.');return {price:{...st.prices[0],status:'retired',enrolment_open:false,retired_at:'2026-11-12T10:00:00Z'}};}return base(path,method,body);};
  let closed=0;c.sheetClose=()=>{closed++;};const form={dataset:{price:'price-one'}};
  await assert.rejects(c.retireMembershipPrice(form),/not known yet/);await assert.rejects(c.retireMembershipPrice(form),/not known yet/);
  assert.equal(mutations(f).length,2);assert.equal(mutations(f)[0][2].request_id,'retire-1');assert.equal(mutations(f)[1][2].request_id,'retire-1');
  assert.equal(closed,0);assert.ok(!f.calls.some(call=>call[0]==='notice'));
  fail=false;await c.retireMembershipPrice(form);
  assert.equal(mutations(f).length,3);assert.equal(mutations(f)[2][0],'/api/v1/billing/membership-prices/price-one/retire');
  assert.deepEqual(JSON.parse(JSON.stringify(mutations(f)[2][2])),{request_id:'retire-1'});
  assert.equal(closed,1);assert.ok(f.calls.some(call=>call[0]==='notice'&&call[1]==='Membership price retired.'&&!call[2]));}
 // Retired prices are not offered when starting a membership; with none left the usual "no prices" line shows.
 f=fixture();c=f.ctx;{
  const retired={...f.price,id:'price-old',name:'Old plan',status:'retired',enrolment_open:false};
  f.s.membershipPrices=[retired,{...f.price,id:'price-new',name:'New plan',enrolment_open:true},{...f.price,id:'price-closed',name:'Closed plan',enrolment_open:false}];
  const form=c.membershipSelectionForm(f.s);assert.match(form,/New plan/);assert.doesNotMatch(form,/Old plan|Closed plan/);
  f.s.membershipPrices=[retired];assert.match(c.membershipSelectionForm(f.s),/No membership prices have been added yet\./);assert.doesNotMatch(c.membershipSelectionForm(f.s),/Old plan|<form/);}
 // Cancel now: only on a running membership the server says can be cancelled now, and only with permission.
 f=fixture();c=f.ctx;{
  const running={request_id:request,price:f.price,status:'active',subscription_status:'active',subscription_id:'sub_one',cancellation_available:false,cancel_at_period_end:true,cancel_now_available:true};
  f.s.memberships=[running];
  let html=c.patientMembershipRows(f.s);assert.match(html,/<button type="button" data-membership-cancel-now="22222222-2222-4222-8222-222222222222">Cancel now<\/button>/);assert.doesNotMatch(html,/data-membership-cancel="/,'period-end button stays tied to its own flag');
  f.s.memberships=[{...running,cancellation_available:true,cancel_at_period_end:false}];html=c.patientMembershipRows(f.s);assert.match(html,/data-membership-cancel="/);assert.match(html,/Cancel at period end<\/button><button type="button" data-membership-cancel-now=/);
  f.s.memberships=[{...running,cancel_now_available:false}];assert.doesNotMatch(c.patientMembershipRows(f.s),/data-membership-cancel-now/);
  f.s.memberships=[{...running,cancel_now_available:undefined}];assert.doesNotMatch(c.patientMembershipRows(f.s),/data-membership-cancel-now/);
  f.s.memberships=[running];c.billingCan=()=>false;assert.doesNotMatch(c.patientMembershipRows(f.s),/data-membership-cancel-now/);assert.equal(c.openCancelNowSheet(f.s,request),null);c.billingCan=()=>true;
  // The sheet: title, one plain line, two buttons.
  const holder={innerHTML:'',querySelector:()=>null};let opened=null;const sheet={isConnected:true,querySelectorAll:()=>[]};
  c.document.createElement=()=>holder;c.sheetOpen=(title,node)=>{opened={title,node};return sheet;};
  assert.equal(c.openCancelNowSheet(f.s,request),sheet);assert.equal(opened.title,'Cancel membership now');
  assert.match(holder.innerHTML,/The membership ends today\. Nothing is refunded and no further charges are made\./);
  assert.match(holder.innerHTML,/<button type="submit">Cancel membership now<\/button>/);assert.match(holder.innerHTML,/data-membership-cancel-now-keep>Keep membership<\/button>/);
  assert.doesNotMatch(holder.innerHTML,/Stripe/i);
  // One request id until it is resolved; a lost answer leaves the usual check / try again card.
  let n=0;c.crypto={randomUUID:()=>'now-'+(++n)};let lost=true;const base=c.api;
  c.api=async(path,method='GET',body)=>{if(path.endsWith('/cancel-now')){f.calls.push([path,method,body]);if(lost)throw Error('The cancellation result is unknown.');return {patient_id:patient,request_id:body.request_id,status:'canceled',kind:'now',subscription:{id:'sub_one'}};}return base(path,method,body);};
  assert.equal(await c.cancelPatientMembershipNow(f.s,request),false);
  assert.equal(mutations(f).length,1);assert.equal(mutations(f)[0][0],`/api/v1/billing/patients/${patient}/memberships/sub_one/cancel-now`);
  assert.deepEqual(JSON.parse(JSON.stringify(mutations(f)[0][2])),{request_id:'now-1'});
  const pending=f.s.membershipPending.find(item=>item.kind==='cancel');assert.equal(pending.status,'unknown');assert.equal(pending.request.cancel_kind,'now');
  assert.match(c.patientMembershipPendingMarkup(f.s),/Check original request/);
  assert.doesNotMatch(c.patientMembershipRows(f.s),/data-membership-cancel-now/,'no second cancel while one is unresolved');
  assert.equal(await c.cancelPatientMembershipNow(f.s,request),false,'cancel-now click repeats the same id');assert.equal(mutations(f)[1][2].request_id,'now-1');
  // Retrying the original request goes to the cancel-now path with the same id.
  lost=false;await c.retryMembershipOperation(f.s,'now-1');
  assert.equal(mutations(f).length,3);assert.match(mutations(f)[2][0],/\/cancel-now$/);assert.equal(mutations(f)[2][2].request_id,'now-1');
  assert.ok(f.calls.some(call=>call[0]==='notice'&&call[1]==='Membership cancelled.'&&!call[2]));}
 // A fresh cancel now posts once and shows the notice.
 f=fixture();c=f.ctx;{
  f.s.memberships=[{request_id:request,price:f.price,status:'active',subscription_status:'active',subscription_id:'sub_one',cancel_now_available:true}];
  const base=c.api;c.api=async(path,method='GET',body)=>path.endsWith('/cancel-now')?(f.calls.push([path,method,body]),{patient_id:patient,request_id:body.request_id,status:'canceled',subscription:{id:'sub_one'}}):base(path,method,body);
  assert.equal(await c.cancelPatientMembershipNow(f.s,request),true);assert.equal(mutations(f).length,1);assert.deepEqual(JSON.parse(JSON.stringify(mutations(f)[0][2])),{request_id:request});
  assert.ok(f.calls.some(call=>call[0]==='notice'&&call[1]==='Membership cancelled.'&&!call[2]));
  f.s.memberships=[{request_id:request,price:f.price,status:'active',subscription_status:'active',subscription_id:'sub_one'}];
  assert.equal(await c.cancelPatientMembershipNow(f.s,request),false);assert.equal(mutations(f).length,1,'nothing is sent unless the server offered it');}
 console.log('PASS patient plans: exact minor-unit schedule, explicit recurring/patient-present consent, duplicate guard, stable request retry, invoice-version preview/create, read-only membership return and existing-only installment refresh');
})().catch(error=>{console.error(error);process.exitCode=1;});
