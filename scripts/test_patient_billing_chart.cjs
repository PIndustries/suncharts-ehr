// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(count=8,testRows=[]){
 const nodes=new Map(),events={},calls=[],pending=[];
 const node=id=>{
  if(!nodes.has(id))nodes.set(id,{id,hidden:false,isConnected:true,innerHTML:'',dataset:{},setAttribute(k,v){this[k]=v;},replaceChildren(){this.innerHTML='';},querySelector(sel){return node(sel.replace(/^[#.]/,''));},querySelectorAll(){return [];}});
  return nodes.get(id);
 };
 const ctx=vm.createContext({URL,URLSearchParams,Intl,Date,console,crypto:{randomUUID:()=> 'synthetic-request'},document:{getElementById:node,addEventListener(k,fn){events[k]=fn;}},calls,pending});
 const run=code=>vm.runInContext(code,ctx);
 run(fs.readFileSync('web/display-format.js','utf8'));
 run(fs.readFileSync('web/app.js','utf8').split('function chartRecordTemplate')[0]);
 Object.assign(ctx,{me:{role:'owner'},selected:'synthetic-patient',chartSection:'billing',workspace:{patient:{id:'synthetic-patient'},visits:[],appointments:[]},billingCan:()=>true,workspaceResourceAllowed:()=>true,money:n=>n==null?'Not available':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100),date:ctx.displayDate,human:ctx.displayStatus,invoicePaymentMethod:x=>({cash:'Cash',check:'Check',card:'Card'}[x]||x||'—'),visitBillingStateName:()=> 'Patient owes',savedCardsForCharge:async()=>({cards:[{id:'saved-card'}]}),savedCardChoiceMarkup:()=>'<select name="card"><option value="saved-card">Card ending 4242</option></select>',run:fn=>pending.push(Promise.resolve().then(fn)),watchSavedCardPayment:op=>calls.push({watch:op})});
 const rows=Array.from({length:count},(_,i)=>({id:'account-'+i,version:3,patient_id:'synthetic-patient',encounter_number:i+1,service_date:`2026-11-${String(24-i%24).padStart(2,'0')}`,created_at:`2026-11-${String(24-i%24).padStart(2,'0')}T12:00:00Z`,total_cents:[61000,53000,83000,2000,135000][i%5],payer_name:'Synthetic plan <unsafe>',insurance_pending_cents:1000,patient_owes_now_cents:2000,account_balance_cents:3000,status:'posted',billing_state:'patient_owes',invoice_id:i===0?'invoice':null,invoice_due_cents:2000,invoice_created_at:'2026-11-24',invoice_needs_review:true}));
 // API pages arrive in creation order, which may differ from service date order.
 rows.reverse();
 let historyPatient='synthetic-patient';
 ctx.api=async(url,method='GET',body)=>{
  calls.push({url,method,body});const q=new URL(url,'https://synthetic.invalid').searchParams;
  if(url.includes('/overview?')){const accountRows=q.get('mode')==='test'?testRows.map(row=>({...row,patient_id:'synthetic-patient'})):rows;return {patient:{id:'synthetic-patient'},summary:{accounts:{reviewed_patient_due_cents:16000},copays:{net_received_cents:18300,usable_unapplied_cents:300,receipts:2,review_count:1}},accounts:{items:accountRows.slice(q.has('accounts_after')?2:0,q.has('accounts_after')?undefined:2),next_cursor:!q.has('accounts_after')&&accountRows.length>2?'account-1':null},copays:{items:[{id:'receipt',method:'cash'}],next_cursor:null}};}
  if(url.includes('/claims?'))return {items:rows.map((r,i)=>({account_id:r.id,status:['draft','submitted','accepted','denied','paid'][i%5]})),next_cursor:null};
  if(url.includes('/payment-history?'))return {patient_id:historyPatient,mode:q.get('mode'),items:count?[{id:'receipt',receipt_id:'receipt',kind:'copay',created_at:'2026-11-24',status:'recorded',received_cents:18300,refunded_cents:300,unapplied_cents:300,reference:'Synthetic reference <unsafe>',ledger_recorded:true}]:[],next_cursor:count?'copay:receipt':null};
  if(url.endsWith('/saved-card-charge'))return {operation:{patient_id:'synthetic-patient',plan_id:'plan',id:'payment'},plan:{id:'plan',invoice_id:'invoice'}};
  if(url.endsWith('/installment-plans'))return {availability:{available:true},items:[],eligible_invoices:count?[{invoice_id:'invoice',invoice_created_at:'2026-11-24',remaining_cents:2000,eligible:true}]:[]};
  if(url.includes('/payment-profile'))return {patient_id:'synthetic-patient',livemode:true,payment_methods:{status:'available',data:{items:[]}}};
  if(url.includes('/invoices?'))return {items:[],next_cursor:null};
  throw new Error('Unexpected URL: '+url);
 };
 run(fs.readFileSync('web/billing-overview.js','utf8'));
 run(fs.readFileSync('web/patient-billing-workspace.js','utf8'));
 return {ctx,run,node,events,calls,pending,rows,setHistoryPatient:p=>{historyPatient=p;}};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function main(){
 let f=fixture();await f.ctx.renderPatientBillingWorkspace(f.node('patient-billing-chart'),'chart');await flush();
 let html=f.node('patient-billing-panel').innerHTML,shell=f.node('patient-billing-chart').innerHTML;
 for(const label of ['Billing &amp; payments','Take payment','Live payments','Test payments','Practice payment settings','Practice billing tools','role="tablist"'])assert.ok(shell.includes(label),label);
 for(const label of ['Patient owes','Insurance pending','Paid','Credit','2 receipts · after refunds','1 receipts to re-check','Money still with insurance','ENC 8','$610.00','$530.00','$830.00','$20.00','$1,350.00','$183.00','Cash','View receipt','Partially refunded','Next payments','No statement prepared','View statement','Needs review'])assert.ok(html.includes(label),label);
 assert.equal((html.match(/data-account="account-/g)||[]).length,8);
 assert.match(html,/Insurance pending<\/span><strong>\$80.00/);
 assert.ok(html.indexOf('ENC 1')<html.indexOf('ENC 8'));
 assert.match(html,/Nov 24, 2026/);assert.doesNotMatch(html,/>2026-11-|Stripe|<unsafe>/);
 for(const status of ['Not sent','Sent','Accepted','Denied','Paid'])assert.ok(html.includes('>'+status+'</span>'),status);
 assert.match(f.node('patient-billing-balances').innerHTML,/Charge card on file/);
 f.node('patient-billing-chart').querySelectorAll=sel=>sel==='[data-balance-slot]'?[Object.assign(f.node('slot'),{dataset:{balanceSlot:'invoice'}})]:[];
 await f.ctx.openBalanceSavedCard(f.run('patientBillingWorkspace'),'invoice');assert.match(f.node('slot').innerHTML,/4242/);assert.match(f.node('slot').innerHTML,/Charge \$20.00/);
 await f.ctx.chargeBalanceSavedCard(f.run('patientBillingWorkspace'),{dataset:{invoice:'invoice',amount:'2000',request:'synthetic-request'},elements:{card:{value:'saved-card'}}});
 const sent=f.calls.find(c=>c.url?.endsWith('/saved-card-charge'));assert.equal(sent.method,'POST');assert.equal(sent.body.saved_card_setup_id,'saved-card');assert.equal(sent.body.amount_cents,2000);
 // The selector and cursor controls use the existing event handlers.
 f.events.change({target:{id:'patient-billing-mode',value:'test'}});await Promise.all(f.pending);assert.ok(f.calls.some(c=>c.url?.includes('/payment-history?mode=test')));
 await f.ctx.changePatientBillingTab('methods');assert.equal(f.run('patientBillingWorkspace.tab'),'methods');assert.equal(f.node('patient-billing-scope').hidden,true);
 await f.ctx.changePatientBillingTab('overview');assert.equal(f.node('patient-billing-scope').hidden,false);
 f=fixture(52);await f.ctx.renderPatientBillingWorkspace(f.node('patient-billing-chart'),'chart');html=f.node('patient-billing-panel').innerHTML;
 assert.equal((html.match(/data-account="account-/g)||[]).length,50);assert.match(html,/Next accounts/);assert.match(html,/\$520.00/);
 const cursor=/data-hub-accounts="([^"]+)"/.exec(html)[1],host=f.node('patient-billing-chart');
 const button={dataset:{hubAccounts:cursor},hasAttribute:()=>false,closest:selector=>selector==='button'?button:host};
 f.events.click({target:button});await Promise.all(f.pending);html=f.node('patient-billing-panel').innerHTML;
 assert.equal((html.match(/data-account="account-/g)||[]).length,2);assert.match(html,/First accounts page/);assert.match(html,/\$520.00/);
 button.dataset={};button.hasAttribute=a=>a==='data-hub-accounts-first';f.events.click({target:button});await Promise.all(f.pending);assert.equal((f.node('patient-billing-panel').innerHTML.match(/data-account="account-/g)||[]).length,50);
 // Live chart history includes all pages of test-touched accounts without changing live totals.
 const testAccounts=Array.from({length:3},(_,i)=>({id:'test-account-'+i,encounter_number:90+i,service_date:`2026-11-${25+i}`,total_cents:999999,insurance_pending_cents:999999,test_activity:true,status:'posted'}));
 f=fixture(8,testAccounts);await f.ctx.renderPatientBillingWorkspace(f.node('patient-billing-chart'),'chart');html=f.node('patient-billing-panel').innerHTML;
 assert.equal((html.match(/data-account="(?:test-)?account-/g)||[]).length,11);
 assert.equal((html.match(/>Test payment<\/span>/g)||[]).length,3);
 assert(html.indexOf('ENC 92')<html.indexOf('ENC 90')&&html.indexOf('ENC 90')<html.indexOf('ENC 1'));
 assert.match(html,/Insurance pending<\/span><strong>\$80.00/);
 assert.match(html,/Patient owes<\/span><strong>\$160.00/);
 assert(f.calls.some(c=>c.url?.includes('mode=test')&&c.url.includes('accounts_after=')));
 // Sorting and pagination operate on the merged history, including the boundary at 50.
 f=fixture(49,testAccounts);await f.ctx.renderPatientBillingWorkspace(f.node('patient-billing-chart'),'chart');html=f.node('patient-billing-panel').innerHTML;
 assert.equal((html.match(/data-account="(?:test-)?account-/g)||[]).length,50);
 const mergedCursor=/data-hub-accounts="([^"]+)"/.exec(html)[1],mergedHost=f.node('patient-billing-chart');
 const mergedButton={dataset:{hubAccounts:mergedCursor},hasAttribute:()=>false,closest:selector=>selector==='button'?mergedButton:mergedHost};
 f.events.click({target:mergedButton});await Promise.all(f.pending);html=f.node('patient-billing-panel').innerHTML;
 assert.equal((html.match(/data-account="(?:test-)?account-/g)||[]).length,2);assert.match(html,/Insurance pending<\/span><strong>\$490.00/);
 // A duplicate account is shown once, with its test marker.
 f=fixture(8,[{...testAccounts[0],id:'account-0'}]);await f.ctx.renderPatientBillingWorkspace(f.node('patient-billing-chart'),'chart');
 html=f.node('patient-billing-panel').innerHTML;assert.equal((html.match(/data-account="account-/g)||[]).length,8);assert.equal((html.match(/>Test payment<\/span>/g)||[]).length,1);
 // Practice worklists retain mode scoping and do not fetch the other mode.
 f=fixture();await f.ctx.renderPatientBillingWorkspace(f.node('global-billing'),'global',{patientId:'synthetic-patient',tab:'payments',mode:'recorded'});
 assert(!f.calls.some(c=>c.url?.includes('/overview?')&&c.url.includes('mode=test')));
 // Cross-patient test history is rejected before it can enter the chart.
 f=fixture(8,testAccounts);const originalApi=f.ctx.api;f.ctx.api=async(url,...args)=>{const result=await originalApi(url,...args);if(url.includes('/overview?')&&url.includes('mode=test'))result.patient.id='other-synthetic-patient';return result;};
 await f.ctx.renderPatientBillingWorkspace(f.node('patient-billing-chart'),'chart');html=f.node('patient-billing-panel').innerHTML;
 assert.match(html,/do not match the selected patient/);assert.doesNotMatch(html,/ENC 90/);
 f=fixture(0);await f.ctx.renderPatientBillingWorkspace(f.node('patient-billing-chart'),'chart');html=f.node('patient-billing-panel').innerHTML;
 for(const label of ['Encounters and charges','<th scope="col">Date','<th scope="col">Next step','No encounters with charges recorded.','<h3>Payments</h3>','<th>Method</th>','No payments in this view.'])assert.ok(html.includes(label),label);
 // A mismatched history never renders another patient's payment; charges stay available.
 f=fixture();f.setHistoryPatient('another-synthetic-patient');await f.ctx.renderPatientBillingWorkspace(f.node('patient-billing-chart'),'chart');html=f.node('patient-billing-panel').innerHTML;assert.match(html,/ENC 8/);assert.match(html,/Payments could not be loaded/);assert.doesNotMatch(html,/View receipt/);
 f.ctx.billingCan=()=>false;assert.doesNotMatch(f.ctx.patientBillingShell(f.run('patientBillingWorkspace')),/data-chart-payment/);
 // Collect finds the selected encounter even beyond the patient's first page.
 f=fixture();f.ctx.dollars=n=>(n/100).toFixed(2);f.ctx.showTool=()=>{};
 await f.ctx.patientBillingCollect('synthetic-patient','account-0','recorded');
 assert.match(f.node('patient-billing-preview').innerHTML,/data-hub-collect-form/);
 assert.match(f.node('patient-billing-preview').innerHTML,/data-account="account-0" data-version="3"/);
 assert.match(f.node('patient-billing-preview').innerHTML,/I received this payment/);
 assert.ok(f.calls.some(c=>c.url?.includes('accounts_after=')));
 // Billing-only staff can open and act on every practice balance.
 f=fixture();f.ctx.workspaceResourceAllowed=resource=>resource!=='clinical';
 await f.ctx.renderPatientBillingWorkspace(f.node('global-billing'),'global',{patientId:null,tab:'overview',mode:'recorded'});
 const actualPractice=f.node('patient-billing-panel').innerHTML;
 for(const label of ['data-hub-open=','>Collect</button>','>Send statement</button>','Gross charges','Copay receipts'])assert.ok(actualPractice.includes(label),label);

 f=fixture();f.ctx.workspaceResourceAllowed=resource=>resource!=='clinical';
 const practice=f.ctx.patientBillingAccounts({accounts:{items:[{id:'account-0',patient_id:'synthetic-patient',patient_name:'Synthetic patient',status:'posted',patient_owes_now_cents:2000,total_cents:3000}]}},{surface:'global',patientId:null,mode:'recorded'});
 for(const label of ['data-hub-open="synthetic-patient"','>Open</button>','data-hub-collect="synthetic-patient"','>Collect</button>','data-hub-statement="synthetic-patient"','>Send statement</button>'])assert.ok(practice.includes(label),label);
 assert.doesNotMatch(practice,/data-billing-patient/);
 await f.ctx.renderPatientBillingWorkspace(f.node('global-billing'),'global',{patientId:'synthetic-patient',tab:'overview',mode:'recorded'});
 let opened;f.ctx.showPatientBillingWorkspace=async options=>{opened=options;};
 const practiceHost=f.node('global-billing'),openButton={dataset:{hubOpen:'synthetic-patient'},hasAttribute:()=>false,closest:sel=>sel==='button'?openButton:practiceHost};
 f.events.click({target:openButton});await Promise.all(f.pending);assert.equal(opened.patientId,'synthetic-patient');assert.equal(opened.tab,'overview');
 // Statement uses the existing native builder and explicitly explains print-only delivery.
 const statementApi=f.ctx.api;f.ctx.api=async(url,method,body)=>url.endsWith('/statement')?(f.calls.push({url,method,body}),{invoice:{id:'synthetic-statement'}}):statementApi(url,method,body);
 let preview;f.ctx.showPatientBillingDocument=async(kind,id)=>{preview={kind,id};};
 f.node('patient-billing-preview').insertAdjacentHTML=(_where,html)=>{f.node('patient-billing-preview').innerHTML+=html;};
 await f.ctx.patientBillingStatement('synthetic-patient','account-0','recorded');
 assert.equal(preview.kind,'invoice');assert.equal(preview.id,'synthetic-statement');assert.match(f.node('patient-billing-preview').innerHTML,/Electronic sending is not available here/);
 assert.ok(f.calls.some(c=>c.url?.endsWith('/account-0/statement')&&c.method==='POST'));
 console.log('PASS billing chart totals, eight encounters, date order, claim pills, payments, saved-card charge, tabs, modes, pagination, empty states and patient isolation');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
