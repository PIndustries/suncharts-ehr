// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic fixtures exercise the mounted page and existing action nodes, without a server.
const assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const source=fs.readFileSync('web/patient-revenue.js','utf8');
new (require('node:vm').Script)(source); // Parse the full module as well as exercising its mounted steps.
const appointmentSource=source.slice(source.indexOf('function revenueAppointment'),source.indexOf('function revenueServiceDate'));
const codeStrip=source.slice(source.indexOf('function encounterCodesStripMarkup'),source.indexOf('// The claim form is offered'));
function fixture({signed=false,selfPay=false,sent=false,paid=false,ready=true,closed=false,unposted=false,insuranceMessage=''}={}){
 const dom=new JSDOM(`<main class="frame-content"><section id="chart"><div id="patient-banner"></div><div id="visit-page-host"><div id="encounter-progress"></div><div id="visit-editor"><div id="encounter-intake"><div id="encounter-benefits"><details><summary>Synthetic Plan · Copay $25 · Active</summary>Coverage detail</details></div><section id="encounter-rooming-vitals"><h3 class="visit-section-label">Rooming &amp; vitals</h3><div class="section-head"><h3>Rooming</h3><span class="badge" data-rooming-status>Not started</span></div><form id="rooming-form"><select name="status"><option value="in_progress" ${ready?'':'selected'}>Rooming</option><option value="ready" ${ready?'selected':''}>Ready</option></select><textarea name="chief_complaint">${ready?'Synthetic concern':''}</textarea><input type="checkbox" name="medications_reviewed" ${ready?'checked':''}><input type="checkbox" name="allergies_reviewed" ${ready?'checked':''}></form></section></div><div id="encounter-documentation"><div id="encounter-billing-editor"><input name="code" value="SYN01"></div><h3 class="visit-section-label">Note</h3><form id="note-form"><button type="button" class="primary" data-action="sign-bill">Sign &amp; bill</button><button type="button" data-action="sign">Sign note</button></form></div></div><section id="encounter-revenue"><div id="encounter-revenue-status"><div class="visit-billing-card"><div class="visit-billing-totals">Money</div><section id="visit-billing-review"><button type="button" data-visit-review-send>Send claim</button></section></div></div><div id="visit-billing-payments">Receipt</div><details id="visit-billing-history"><summary>History</summary><div>Technical details</div></details></section><div id="visit-checkout"><form id="checkout-complete-form"><button type="submit">Finish encounter</button></form></div></div></section></main>`,{runScripts:'outside-only'});
 const w=dom.window;
 const style=w.document.createElement('style');style.textContent=fs.readFileSync('web/visit-billing.css','utf8');w.document.head.append(style);
 w.IntersectionObserver=class {
  constructor(callback,options){this.callback=callback;this.options=options;this.targets=[];w.scrollObserver=this;}
  observe(node){this.targets.push(node);}
  disconnect(){this.disconnected=true;}
 };
 const frame=w.document.querySelector('.frame-content');frame.scrollTop=700;frame.scrollCalls=[];frame.scrollTo=options=>frame.scrollCalls.push(options);
 w.scroll=w.scrollTo=w.scrollBy=()=>{throw new Error('encounter steps must not scroll the window');};
 w.HTMLElement.prototype.scrollIntoView=()=>{throw new Error('encounter steps must not scroll ancestors');};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 w.$=id=>w.document.getElementById(id);w.money=n=>'$'+(n/100).toFixed(2);w.esc=s=>String(s??'');
 require('node:vm').runInContext(fs.readFileSync('web/visit-billing.js','utf8'),dom.getInternalVMContext());
 w.selected='synthetic-patient';w.activeVisit={id:'synthetic-encounter',appointment_id:'appointment',status:signed?'signed':'in_progress',vitals:{systolic_mm_hg:120,diastolic_mm_hg:80}};
 w.scheduleInsuranceCheckMessage=()=>insuranceMessage;
 w.workspace={appointments:[]};w.encounterRevenueState={data:{summary:{state:paid?'paid_in_full':sent?'waiting_insurer':signed?'post_charges':'sign_visit',charges_cents:53000,account:{status:signed&&!unposted?'posted':'draft'},insurance:{insured:!selfPay,status:paid?'answered':sent?'waiting':'not_sent',paid_cents:paid?50500:0},patient:{copay_cents:2500,copay_paid_cents:2500,copay_due_cents:0,owes_now_cents:paid?0:2500}}}};
 w.workspace.appointments=[{id:'appointment',patient_id:w.selected,status:'completed'}];
 Object.assign(w.encounterRevenueState.data.summary,{patient_id:w.selected,visit:w.activeVisit});
 w.checkoutKey=()=> 'synthetic';w.checkoutStates=new Map([['synthetic',{checkout:{completed:closed}}]]);
 w.sheetOpen=(title,node)=>{const dialog=w.document.createElement('dialog');dialog.append(node);w.document.body.append(dialog);return dialog;};
 w.eval(appointmentSource+codeStrip+source.slice(source.indexOf('// One continuous encounter')));w.eval('encounterStepsSync()');
 return {w,dom,page:w.$('visit-page-host'),sync:()=>w.eval('encounterStepsSync()'),model:()=>w.eval('encounterStepsModel(encounterRevenueState.data.summary,activeVisit,{},false,{status:"ready"})')};
}
{
 const f=fixture(),w=f.w,room=w.$('rooming-form'),note=w.$('note-form'),bar=w.$('encounter-stepper');
 const chief=room.elements.chief_complaint,label=w.document.createElement('label');
 room.dataset.roomingEditable='true'; room.dataset.visitId=w.activeVisit.id;
 chief.before(label);label.append(chief);label.setAttribute('data-rooming-needed','');chief.value='';
 note.dataset.visitId=w.activeVisit.id;
 f.sync();
 assert.equal(bar.querySelector('[data-step-primary]'),null,'rooming already shows the highlighted field');
 chief.focus();
 assert.equal(w.document.activeElement,chief);assert.equal(chief.value,'');
 assert(note.querySelector('[data-action="sign-bill"]').hidden,'an encounter without claim preflight only offers standalone signing');
 const sign=note.querySelector('[data-action="sign"]');
 assert.equal(sign.hidden,false);
 assert.equal(sign.textContent,'Sign note');
 f.dom.window.close();
}
const visible=f=>{for(const node of f.page.querySelectorAll('[data-encounter-step-number],[data-encounter-section]'))assert.equal(node.hidden,false);};
for(const options of [{},{selfPay:true},{signed:true},{signed:true,sent:true},{signed:true,selfPay:true},{signed:true,selfPay:true,paid:true},{signed:true,paid:true},{signed:true,paid:true,closed:true}]){
 const f=fixture(options),w=f.w,frame=w.document.querySelector('.frame-content');
 visible(f);
 assert.deepEqual([...f.page.querySelectorAll('[data-encounter-label] > span:first-child')].map(n=>n.textContent),['Rooming & vitals','Note','Payment']);
 assert.deepEqual([...f.page.querySelectorAll('[data-encounter-step-open]')].map(chip=>chip.textContent.replace(/^✓ /,'')),['Visit','Payment']);
 assert.equal(f.page.querySelector('[data-step-claim]'),null);
 assert.equal(f.page.querySelector('[data-encounter-claim-status]').hidden,Boolean(options.selfPay));
 assert(f.page.querySelector('#encounter-documentation [data-encounter-claim-status] #visit-billing-review'));
 assert.equal(w.$('encounter-rooming-vitals').querySelectorAll('.pill,.badge').length,0);
 const note=w.$('note-form');frame.scrollTop=420;
 for(const chip of f.page.querySelectorAll('[data-encounter-step-open]')){chip.click();visible(f);}
 assert.equal(w.$('note-form'),note);
 assert.deepEqual(frame.scrollCalls.map(call=>call.behavior),Array(2).fill('smooth'));
 const payment=f.page.querySelector('[data-encounter-step-number="2"] [data-encounter-label]');
 assert.equal(w.document.activeElement,payment);
 f.sync();assert.equal(w.document.activeElement,payment);assert.equal(frame.scrollTop,420);
 const optional=f.page.querySelector('dialog[data-visit-followup-dialog]');
 const launch=f.page.querySelector('[data-open-visit-followup]');
 assert(optional.contains(w.$('visit-checkout')));assert.equal(optional.open,false);
 assert.equal(launch.textContent,'Patient instructions & follow-up');
 w.encounterStepOpen(3,{focus:true});assert.equal(optional.open,true);
 assert.equal(w.$('encounter-stepper').querySelector('[data-step-primary]'),null);
 if(!options.signed){
  const payment=f.page.querySelector('[data-step-payment]');
  assert.match(payment.textContent,options.selfPay?/Balance available after charges are posted/:/No copay due/);
  assert.equal(payment.querySelector('[data-encounter-charges]'),null);
  assert.equal(payment.querySelector('.visit-billing-totals'),null);
 }
 f.dom.window.close();
}
{
 const active=fixture();
 assert.equal(active.page.querySelector('[data-signed-intake]'),null,'active intake remains visible');
 active.dom.window.close();
 const f=fixture({signed:true,ready:false,insuranceMessage:'The insurer could not confirm coverage.'});
 f.w.$('encounter-rooming-vitals').insertAdjacentHTML('beforeend','<div id="visit-rooming" data-rooming-record-missing="Allergy review not recorded"></div>');
 f.sync();
 const rooming=f.w.$('encounter-rooming-vitals');
 const warnings=rooming.querySelector('[data-signed-intake-warnings]');
 assert(!warnings.hidden);
 assert.match(warnings.textContent,/Allergy review not recorded/);
 assert.equal(f.page.querySelector('[data-signed-intake]'),null);
 assert.equal(f.page.querySelector('[data-step-insurance]'),null);
 f.dom.window.close();
}
{
 const f=fixture({signed:true,selfPay:true,paid:true}),w=f.w;
 const editor=w.$('encounter-billing-editor');
 editor.innerHTML='<form id="billing-account-form"><input name="amount" value="180.00"></form>';
 w.activeVisit.diagnoses=[{code:'R51.9',display:'Headache'}];
 w.encounterRevenueState.data.summary.account.content={lines:[{code:'99213',description:'Office visit',units:1,amount_cents:18000}]};
 f.sync();
 const summary=f.page.querySelector('[data-encounter-codes-summary]');
 const disclosure=f.page.querySelector('dialog[data-encounter-codes-dialog]');
 assert.match(summary.textContent,/R51.9.*Headache/);
 assert.match(summary.textContent,/99213.*Office visit.*× 1.*\$180.00/);
 assert(!disclosure.open);
 assert.equal(f.page.querySelector('[data-open-encounter-codes]').textContent,'Edit codes');
 assert.equal(disclosure.querySelector('#encounter-billing-editor'),editor);
 let suggestionsChecked=0;
 w.diagnosisSuggestCheck=()=>{assert.equal(disclosure.open,true);suggestionsChecked++;};
 f.page.querySelector('[data-open-encounter-codes]').click();
 assert.equal(suggestionsChecked,1,'opening the Codes dialog requests eligible suggestions without an extra click');
 const amount=editor.querySelector('[name="amount"]');amount.value='175.00';
 f.sync();
 assert(disclosure.open);
 assert.equal(editor.querySelector('[name="amount"]'),amount);
 assert.equal(amount.value,'175.00');
 f.dom.window.close();
}
(async()=>{
 const f=fixture(),w=f.w;
 const editor=w.$('encounter-billing-editor');
 editor.innerHTML='<form id="billing-account-form"><input name="amount" value="180.00"><select name="diagnoses"><option>A</option></select><input name="ndc"></form>';
 const diagnosisEditor=w.document.createElement('section');diagnosisEditor.id='encounter-diagnoses';
 diagnosisEditor.innerHTML='<form id="visit-diagnoses-form"><button type="submit">Save</button></form>';
 w.$('encounter-revenue').append(diagnosisEditor);
 w.activeVisit.diagnoses=[];
 f.sync();
 const codeLauncher=f.page.querySelector('[data-open-encounter-codes]');
 assert.equal(editor.closest('dialog[data-encounter-codes-dialog]').open,false);
 assert.equal(codeLauncher.textContent,'Add diagnosis');
 assert.deepEqual([...f.page.querySelectorAll('.encounter-code-needed')].map(node=>node.textContent),['Add a diagnosis to bill this visit.','Add a procedure to bill this visit.']);
 w.activeVisit.diagnoses=[{code:'R51.9',display:'Headache'}];
 f.sync();
 assert.equal(codeLauncher.textContent,'Add procedure');
 assert.equal(f.page.querySelectorAll('.encounter-code-needed').length,1);
 w.encounterRevenueState.data.summary.account.content={lines:[{code:'99213',description:'Office visit',units:1,amount_cents:18000}]};
 f.sync();
 const panel=f.page.querySelector('dialog[data-encounter-codes-dialog]');
 assert.equal(panel.open,false,'saved codes on an unsigned encounter start in review mode');
 assert.equal(f.page.querySelector('[data-encounter-codes-heading] h3').textContent,'Diagnoses & procedures');
 assert.match(f.page.querySelector('[data-encounter-codes-summary]').textContent,/R51.9.*99213/);
 assert.equal(f.page.querySelector('[data-open-encounter-codes]').textContent,'Edit codes');
 assert.equal(f.page.querySelectorAll('.encounter-code-needed').length,0);
 assert.equal(panel.querySelector('#billing-account-form'),editor.firstElementChild);
 f.page.querySelector('[data-open-encounter-codes]').click();
 const amount=editor.querySelector('input');amount.focus();amount.value='192.00';
 f.sync();
 assert.equal(w.document.activeElement,amount);
 assert.equal(amount.value,'192.00');
 assert.equal(panel.querySelectorAll('[name="ndc"]').length,1);
 assert.equal(panel.querySelectorAll('[name="diagnoses"]').length,1);
 let startSave,finishSave;
 const started=new Promise(resolve=>{startSave=resolve;});
 const save=new Promise(resolve=>{finishSave=resolve;});
 const closed=new Promise(resolve=>panel.addEventListener('close',resolve,{once:true}));
 w.flushVisitCodeDiagnoses=async()=>{};
 w.flushEncounterProcedures=form=>{assert.equal(form,editor.firstElementChild);startSave();return save;};
 panel.querySelector('[data-close-encounter-codes]').click();
 await started;
 assert.equal(panel.open,true);
 finishSave();
 await closed;
 f.sync();
 assert.equal(panel.open,false);
 assert.equal(w.document.activeElement,f.page.querySelector('[data-open-encounter-codes]'));
 f.dom.window.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
{
 const f=fixture({signed:true,selfPay:true,unposted:true}),w=f.w,frame=w.document.querySelector('.frame-content');
 const editor=w.$('encounter-billing-editor');
 editor.innerHTML='<div data-charge-next><button data-visit-post-charges="account">Post charges</button></div>';
 f.sync();
 assert.equal(f.page.dataset.stepCurrent,'1');
 assert.equal(w.$('encounter-stepper').querySelector('[data-step-primary]'),null);
 f.page.querySelector('[data-open-encounter-codes]').click();
 assert(editor.closest('dialog').open);
 editor.closest('dialog').close();
 w.$('encounter-stepper').getBoundingClientRect=()=>({bottom:140});
 f.page.querySelector('[data-encounter-codes-heading]').getBoundingClientRect=()=>({top:600});
 frame.scrollTop=100;
 w.encounterStepOpen('claim');
 assert.equal(frame.scrollCalls.at(-1).top,552,'older Charges links land at the visible code summary and its editor launcher');
 f.dom.window.close();
}
{
 const f=fixture({signed:true}),w=f.w,review=w.$('visit-billing-review');
 review.innerHTML='<section data-signed-claim-summary><button data-open-signed-claim-details>Claim details</button></section>';
 w.encounterRevenueState.data.summary.state='add_charges';
 f.sync();
 const home=f.page.querySelector('[data-step-claim-actions]'),controls=home.querySelector('[data-claim-option-controls]');
 assert(home.hidden);
 assert.equal(w.$('encounter-stepper').querySelector('[data-step-primary],[data-step-problems]'),null);
 assert.match(f.page.querySelector('[data-encounter-codes-summary]').textContent,/Add a procedure to bill this visit/);
 const dialog=w.document.createElement('dialog');dialog.dataset.signedClaimDetails='';dialog.innerHTML='<div data-claim-secondary-host></div>';
 w.document.body.append(dialog);dialog.showModal();w.encounterClaimOptionsMount(dialog);f.sync();
 assert(dialog.contains(controls));assert.equal(home.querySelector('[data-claim-option-controls]'),null);
 dialog.close();dialog.remove();w.encounterClaimOptionsRestore(dialog);assert(home.contains(controls));
 assert.equal(f.page.querySelectorAll('[data-claim-option-controls]').length,1);
 f.dom.window.close();
}
{
 const f=fixture(),w=f.w;
 w.$('visit-editor').innerHTML='<div id="encounter-intake"><section id="encounter-rooming-vitals">Refreshed synthetic rooming</section></div>';
 f.sync();f.sync();
 assert.equal(f.page.querySelectorAll('#encounter-rooming-vitals').length,1);
 assert.match(w.$('encounter-rooming-vitals').textContent,/Refreshed synthetic rooming/);
 f.dom.window.close();
}
{
 const f=fixture(),w=f.w,frame=w.document.querySelector('.frame-content');
 const chip=f.page.querySelector('[data-encounter-step-open="1"]');
 const label=f.page.querySelector('[data-encounter-step-number="1"] [data-encounter-label]');
 const stepper=w.$('encounter-stepper');
 w.motionReduced=()=>true;
 stepper.style.top='140px';Object.defineProperty(stepper,'offsetHeight',{value:60});
 stepper.getBoundingClientRect=()=>({bottom:300});label.getBoundingClientRect=()=>({top:800});
 frame.scrollTop=0;
 chip.focus();chip.dispatchEvent(new w.MouseEvent('click',{bubbles:true,detail:1}));
 assert.equal(w.document.activeElement,chip);
 assert.equal(frame.scrollCalls.at(-1).behavior,'instant');
 assert.equal(frame.scrollCalls.at(-1).top,592);
 f.sync();assert.equal(w.document.activeElement.dataset.encounterStepOpen,'1');
 w.encounterStepOpen('claim');
 assert.equal(frame.scrollCalls.at(-1).behavior,'instant');
 f.dom.window.close();
}
// At the frame's scroll limit, Payment stays selected even while Claim is partly visible.
{
 const f=fixture(),w=f.w,frame=w.document.querySelector('.frame-content');
 let scrollHeight=1100;
 Object.defineProperties(frame,{scrollHeight:{get:()=>scrollHeight},clientHeight:{value:800}});
 const last=f.page.querySelector('[data-encounter-step-number="2"] [data-encounter-label]');
 last.getBoundingClientRect=()=>({top:650});
 const visit=f.page.querySelector('[data-encounter-step-number="1"]');
 const viewed=()=>f.page.querySelector('[data-step-viewed="true"]').dataset.encounterStepOpen;
 const seeVisit=()=>w.scrollObserver.callback([{target:visit,isIntersecting:true}]);
 const clickPayment=()=>f.page.querySelector('[data-encounter-step-open="2"]').click();
 const current=()=>f.page.querySelector('[aria-current="step"]').dataset.encounterStepOpen;
 frame.scrollTop=200;seeVisit();clickPayment();
 assert.equal(viewed(),'1');
 frame.scrollTop=300;frame.dispatchEvent(new w.Event('scroll'));
 assert.equal(viewed(),'2');assert.equal(current(),'1');
 f.sync();seeVisit();assert.equal(viewed(),'2');
 scrollHeight=1082;frame.scrollTop=275;f.sync();seeVisit();frame.dispatchEvent(new w.Event('scroll'));
 assert.equal(viewed(),'2');
 frame.scrollTop=200;frame.dispatchEvent(new w.Event('scroll'));assert.equal(viewed(),'1');
 frame.scrollTop=282;clickPayment();assert.equal(viewed(),'2');
 f.dom.window.close();
}
// The viewed mark follows scrolling without changing completion/current state.
(async()=>{
 const f=fixture(),w=f.w,observer=w.scrollObserver;
 assert.equal(observer.options.root,w.document.querySelector('.frame-content'));
 assert.equal(observer.targets.length,3);
 const before=[...f.page.querySelectorAll('[data-step-state]')].map(n=>n.dataset.stepState);
 const visit=f.page.querySelector('[data-encounter-step-number="1"]');
 observer.callback([{target:visit,isIntersecting:true,boundingClientRect:{top:240}}]);
 assert.equal(f.page.querySelector('[data-step-viewed="true"]').dataset.encounterStepOpen,'1');
 assert.deepEqual([...f.page.querySelectorAll('[data-step-state]')].map(n=>n.dataset.stepState),before);
 f.sync();assert(observer.disconnected);assert.equal(f.page.querySelector('[data-step-viewed="true"]').dataset.encounterStepOpen,'1');
 const link=w.document.createElement('button');link.dataset.encounterCodesAnchor='';visit.append(link);link.click();
 const codesDialog=w.$('encounter-billing-editor').closest('[data-encounter-codes-dialog]');assert.equal(codesDialog.open,true,'the Edit codes link opens the mounted form in its modal');
 w.flushVisitCodeDiagnoses=async()=>{};
 w.flushEncounterProcedures=async()=>{};
 codesDialog.querySelector('[data-close-encounter-codes]').click();
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(codesDialog.open,false);
 assert.equal(w.document.activeElement,link);
 assert.equal(w.$('encounter-billing-editor').closest('[data-encounter-step-number]').dataset.encounterStepNumber,'1');
 assert.equal(f.page.querySelector('[data-step-insurance]'),null);
 f.dom.window.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
{
 const f=fixture(),s=f.w.encounterRevenueState.data.summary;
 s.patient.copay_due_cents=2500;
 f.sync();
 const quick=f.page.querySelector('[data-encounter-early-payment]');
 assert.equal(quick.textContent,'Take $25.00 copay');
 assert.equal(f.page.querySelector('[data-encounter-next]').textContent,'Sign note');
 f.w.workspace.appointments=[];
 f.sync();
 assert(quick.hidden,'Do not open a collection window for an unlinked visit');
 assert.match(f.page.querySelector('[data-step-payment]').textContent,/requires an active appointment/);
 s.patient.copay_due_cents=0;
 s.receipts=[{id:'synthetic-receipt',amount_cents:2500,refunded_cents:0,test:true}];
 f.sync();
 assert.equal(f.page.querySelector('[data-payment-summary]').textContent,'Test copay recorded');
 s.receipts[0].test=false;
 f.sync();
 assert.equal(f.page.querySelector('[data-payment-summary]').textContent,'Copay recorded');
 f.dom.window.close();
}
// Count workflow presses with completed synthetic booking and all required data entered.
for(const selfPay of [false,true]){
 const f=fixture({selfPay}),w=f.w,bar=w.$('encounter-stepper'),frame=w.document.querySelector('.frame-content');
 let presses=0;
 const fixtureAction=label=>{const button=w.document.createElement('button');button.textContent=label;button.onclick=()=>presses++;w.document.body.append(button);button.click();button.remove();};
 for(const label of ['Book appointment','Check in','Start encounter'])fixtureAction(label);
 frame.scrollTop=410;
 const sign=w.$('note-form').querySelector('[data-action="sign"]');
 sign.onclick=()=>{w.activeVisit.status='signed';w.encounterRevenueState.data.summary.account.status='posted';f.sync();};
 w.$('visit-billing-review').querySelector('[data-visit-review-send]').onclick=()=>{w.encounterRevenueState.data.summary.insurance.status='waiting';f.sync();};
 w.run=action=>action();
 sign.click();
 if(!selfPay)w.$('visit-billing-review').querySelector('[data-visit-review-send]').click();
 const take=f.page.querySelector('[data-step-payment] [data-visit-collect]');
 let collections=0;take.onclick=()=>collections++;take.click();
 assert.equal(collections,1);
 assert.equal(frame.scrollTop,410);
 assert.equal(bar.querySelector('[data-step-primary]'),null);
 assert.equal(f.page.querySelector('dialog[data-visit-followup-dialog]').open,false);
 f.dom.window.close();
}
{
 const f=fixture(),w=f.w,frame=w.document.querySelector('.frame-content');frame.scrollTop=480;
 const restore=w.encounterStepPosition();frame.scrollTop=0;w.activeVisit.status='signed';f.sync();restore();assert.equal(frame.scrollTop,480);visible(f);f.dom.window.close();
}
{
 const f=fixture({signed:true,selfPay:true,paid:true}),w=f.w,s=w.encounterRevenueState.data.summary;
 const receipt={id:'receipt-applied',appointment_id:'appointment',amount_cents:18000,occurred_on:'2026-11-24',method:'cash'};
 const other={...receipt,id:'receipt-independent'};
 const ledger=w.$('visit-billing-payments');
 ledger.innerHTML='<button data-copay-receipt="receipt-applied">Receipt</button><button data-visit-collect>Take payment</button><button data-new-ledger>Record adjustment</button><button data-reverse-entry="entry">Reverse</button>';
 w.$('encounter-revenue').insertAdjacentHTML('beforeend','<section id="visit-billing-invoices"><button data-visit-statement-open="statement">View statement</button></section>');
 s.account.id='account';s.receipts=[receipt];s.visit={id:w.activeVisit.id,appointment_id:receipt.appointment_id};
 s.balance_cents=0;s.patient={received_cents:18000,owes_now_cents:0,unapplied_cents:18000};
 const record={...receipt,allocated_cents:0},unallocated={...other,allocated_cents:0};
 const records=[record];
 w.workspace.billing={copays:records,entries:[{id:'entry',account_id:s.account.id,kind:'payment',effect_cents:-18000,content:{copay_receipt_id:receipt.id}}]};
 f.sync();
 const payment=f.page.querySelector('[data-step-payment]'),details=f.page.querySelector('[data-step-payment-details]');
 const amount=()=>payment.querySelector('[data-payment-summary]').textContent;
 assert.equal(amount(),'No patient amount due');
 assert.equal(payment.querySelector('[data-copay-receipt]').dataset.copayReceipt,receipt.id);
 assert.equal(payment.querySelector('[data-visit-collect]'),null);
 assert.equal(details.open,false);
 assert.equal(details.tagName,'DIALOG');
 assert(details.contains(ledger));
 assert(details.querySelector('[data-reverse-entry]'));
 assert(details.querySelector('[data-visit-statement-open]'));
 assert(details.querySelector('[data-visit-history="payments"]'));
 assert.equal(details.querySelector('#visit-billing-payments [data-visit-collect]').hidden,true);
 assert.match(details.textContent,/confirm how recorded payments were applied/);
 assert.doesNotMatch(details.textContent,/Unapplied credit/);
 assert.equal(details.querySelector('[data-apply-copays],[data-copay-void]'),null);
 payment.querySelector('[data-open-encounter-payment-history]').click();
 record.allocated_cents=18000;records.push(unallocated);s.receipts.push(other);
 s.patient.received_cents=36000;s.patient.owes_now_cents=6500;s.balance_cents=6500;
 s.state='self_pay_collect';
 f.sync();
 assert.equal(amount(),'Patient amount due $65.00');
 assert.equal(payment.querySelector('.primary').textContent,'Take payment');
 assert.match(details.textContent,/Unapplied credit \$180.00/,'an independent receipt can carry credit even when its amount equals the applied receipt');
 assert.equal(details.querySelector('[data-copay-void]').dataset.copayVoid,other.id);
 assert(details.querySelector('[data-apply-copays]'));
 assert.equal(details.open,true);
 assert.equal(f.page.querySelector('[data-step-payment-details]'),details);
 w.billingCan=()=>false;f.sync();
 assert.equal(details.querySelector('[data-apply-copays],[data-copay-void]'),null);
 s.patient={received_cents:0,owes_now_cents:6500};s.receipts=[];f.sync();
 assert.equal(amount(),'Patient amount due $65.00');
 assert.equal(payment.querySelector('[data-visit-collect]'),null);
 const split={...receipt,id:'split',appointment_id:'second-appointment',amount_cents:10000};
 const full={...receipt,id:split.id,amount_cents:30000,allocated_cents:10000,hosted_checkout:{status:'paid',refunded_unapplied_cents:10000,splits:[{...receipt,amount_cents:20000,allocated_cents:10000},{...split,allocated_cents:0}]}};
 assert.equal(w.visitBillingSelfPayCredits({receipts:[split],patient:{unapplied_cents:10000}},[full],[]).credit,10000,'a refund on a split receipt does not consume a separate encounter’s remaining credit twice');
 f.dom.window.close();
}
const css=fs.readFileSync('web/visit-billing.css','utf8');
assert.match(css,/encounter-step-body\{[^}]*height:auto;overflow:visible/);
assert.match(css,/encounter-step-chips\{[^}]*grid-auto-columns:minmax\(0,1fr\)/);
assert.doesNotMatch(source.slice(source.indexOf('// One continuous encounter')),/window.scroll|scrollIntoView/);
console.log('PASS continuous encounter: all sections visible, content-only anchors, embedded claim status, direct payment and stationary refresh');

(async()=>{
 // The actual renderer shows just the missing fields, keeping the same controls mounted.
 for(const scenario of ['reuse-note','edit','read-only']){
  const canEdit=scenario!=='read-only';
  const f=fixture(),w=f.w,section=w.$('encounter-rooming-vitals');
  section.innerHTML='<div class="visit-rooming-vitals-grid"><div id="visit-rooming"></div><details data-rooming-vitals-review data-inline><summary>Vitals</summary><div class="vitals-grid"><label>Systolic<input name="systolic_mm_hg" value="120"></label></div></details></div>';
  w.activeVisit.version=1;w.displayStatus=value=>value;w.date=value=>value;
  w.formData=form=>Object.fromEntries(new w.FormData(form));
  w.captureVisitDrafts=()=>{};w.notice=()=>{};
  w.rememberVisit=visit=>{w.activeVisit.version=visit.version;};
  w.run=fn=>{w.roomingSave=fn();return w.roomingSave;};
  let saved={version:1,visit:{version:1},can_edit:canEdit,status:'in_progress',chief_complaint:'Synthetic concern',intake_notes:'Synthetic rooming notes',medications_reviewed:false,allergies_reviewed:false,history:[]};
  const writes=[];
  w.api=async(_path,method,values,version)=>{
   if(method==='PUT'){writes.push({values,version});saved={...saved,...values,version:saved.version+1,visit:{version:saved.version+1}};}
   return saved;
  };
  w.eval(fs.readFileSync('web/rooming.js','utf8')+';window.renderRooming=renderRooming;');
  if(scenario==='reuse-note'){
   const note=w.$('note-form'),subject=w.document.createElement('textarea');
   subject.name='subjective';note.append(subject);note.dataset.visitId=w.activeVisit.id;
   w.activeVisit.patient_id=w.selected;w.activeVisit.note={subjective:'Recorded reason for this synthetic visit'};
   saved={...saved,chief_complaint:''};await w.renderRooming();
   const copy=section.querySelector('[data-rooming-use-subjective]');
   assert(!copy.hidden);assert.equal(w.$('rooming-form').elements.chief_complaint.value,'');
   note.dataset.visitId='previous-visit';copy.click();assert.equal(w.$('rooming-form').elements.chief_complaint.value,'');
   note.dataset.visitId=w.activeVisit.id;copy.click();
   assert.equal(w.$('rooming-form').elements.chief_complaint.value,w.activeVisit.note.subjective);
   assert(copy.hidden);assert.equal(writes.length,0,'Using the note is a draft action');
   f.dom.window.close();continue;
  }
  if(canEdit){
   const initial=saved;
   for(const [name,value] of [['chief_complaint',''],['medications_reviewed',false],['allergies_reviewed',false]]){
    saved={...initial,medications_reviewed:true,allergies_reviewed:true,[name]:value};
    await w.renderRooming();
    const required=section.querySelectorAll('[data-rooming-needed]');
    assert.deepEqual([...required].map(item=>item.dataset.roomingField),[name]);
    const control=w.$('rooming-form').elements[name];
    assert.equal(w.$(control.getAttribute('aria-describedby')).textContent,'Needed');
   }
   saved=initial;
  }
  await w.renderRooming();f.sync();
  const form=w.$('rooming-form'),review=form.querySelector('[data-rooming-review]');
  assert(!review.open);
  assert(!section.querySelector('[data-rooming-vitals-review]').open);
  assert(review.contains(form.elements.chief_complaint));
  if(canEdit){
   const needed=()=>[...form.querySelectorAll('[data-rooming-needed]')].map(label=>label.dataset.roomingField);
   assert.deepEqual(needed(),['medications_reviewed','allergies_reviewed']);
   assert(form.querySelector('[type="submit"]').hidden,'untouched rooming does not show an idle Save');
   const check=form.elements.medications_reviewed;check.focus();check.checked=true;
   check.dispatchEvent(new w.Event('input',{bubbles:true}));
   assert.deepEqual(needed(),['allergies_reviewed']);
   assert(review.contains(check),'the completed medication review moves straight into details');
   assert.equal(w.document.activeElement,form.elements.allergies_reviewed,'keyboard focus advances to the remaining review');
   f.sync();f.sync();
   assert.equal(w.document.activeElement,form.elements.allergies_reviewed,'a refresh preserves the next outstanding field');
   assert(!form.querySelector('[type="submit"]').hidden);
   assert.equal(check.getAttribute('aria-describedby'),null);
   const allergy=form.elements.allergies_reviewed;
   assert.equal(w.$(allergy.getAttribute('aria-describedby')).textContent,'Needed');
   assert.equal(allergy.closest('details'),null);
   allergy.focus();allergy.checked=true;
   allergy.dispatchEvent(new w.Event('input',{bubbles:true}));
   assert.deepEqual(needed(),[]);
   assert.equal(form.querySelector('[data-rooming-checklist-state]').dataset.roomingChecklistState,'changes');
   assert.equal(writes.length,0,'paint and local cues are read-only');
   assert(form.querySelector('[data-rooming-mark-ready]').hidden);
   assert(review.contains(allergy));
   assert.equal(form.elements.status.value,'ready');
   assert.equal(w.document.activeElement,form.querySelector('[data-rooming-open-details]'),'keyboard can inspect completed intake');
   form.requestSubmit();
   await w.roomingSave;
   assert.equal(writes.length,1);assert.equal(writes[0].version,1);assert.equal(writes[0].values.status,'ready');
   let restored=w.$('rooming-form');
   assert.match(restored.querySelector('[data-rooming-checklist-state]').textContent,/Rooming complete/);
   const restoredDetails=restored.querySelector('[data-rooming-review]');
   restored.querySelector('[data-rooming-open-details]').click();assert(restoredDetails.open);
   assert.equal(restoredDetails.querySelectorAll('[data-rooming-field]').length,3);
   const focused=restored.elements.chief_complaint;
   focused.value='Retained correction';focused.focus();focused.setSelectionRange(4,4);
   focused.dispatchEvent(new w.Event('input',{bubbles:true}));
   let finishRead;const oldApi=w.api;
   w.api=()=>new Promise(resolve=>{finishRead=()=>resolve(saved);});
   const refreshing=w.renderRooming();
   assert.equal(w.$('rooming-form'),restored);assert.equal(w.document.activeElement,focused);
   finishRead();await refreshing;w.api=oldApi;
   assert.equal(w.$('rooming-form'),restored);
   assert.equal(w.document.activeElement,focused);
   assert.equal(focused.selectionStart,4);
   assert(restored.querySelector('[data-rooming-review]').open);
   assert.equal(focused.value,'Retained correction');
   assert.equal(writes.length,1);
  }else{
   assert.equal(form.querySelectorAll('[data-rooming-needed]').length,0);
   assert.equal(form.querySelector('[type=submit]'),null);
   assert.match(section.textContent,/Medication review not recorded · Allergy review not recorded/);
  }
  f.dom.window.close();
 }
 console.log('PASS rooming shows exact missing controls, retains completed fields and drafts, then saves Ready once');
})().catch(error=>{console.error(error);process.exitCode=1;});

{
 const f=fixture(),summary=f.w.encounterRevenueState.data.summary;
 const ledger=f.w.$('visit-billing-payments'),rows=Array.from({length:5},(_,i)=>({id:'receipt-'+i,appointment_id:'appointment',method:'card',amount_cents:2500,refunded_cents:0,test:true}));
 summary.receipts=rows;summary.patient.unapplied_cents=12500;summary.patient.copay_due_cents=2500;
 ledger.innerHTML=rows.map(r=>`<button data-copay-receipt="${r.id}">Receipt</button>`).join('');
 f.sync();
 const payment=f.page.querySelector('[data-step-payment]'),details=f.page.querySelector('dialog[data-step-payment-details]');
 assert.match(payment.textContent,/Copay due \$25.00/);
 assert.equal(payment.querySelectorAll('[data-visit-collect]').length,1);
 assert.doesNotMatch(payment.textContent,/test receipts|unapplied|\$125.00/);
 assert(!details.open&&details.contains(ledger));
 assert.equal(details.querySelectorAll('[data-copay-receipt]').length,5);
 assert(!details.querySelector('[data-copay-void]'));
 f.w.encounterRevenueState.data.stale=true;f.sync();
 assert.equal(payment.querySelector('[data-visit-collect]'),null);
 f.w.encounterRevenueState.data.stale=false;f.sync();
 payment.querySelector('[data-open-encounter-payment-history]').click();f.sync();assert(details.open);
 rows[0].test=false;rows[0].refunded_cents=500;summary.patient.unapplied_cents=12000;
 ledger.querySelector('[data-copay-receipt="receipt-0"]').remove();f.sync();
 assert.equal(details.querySelectorAll('[data-copay-receipt="receipt-0"]').length,1);
 summary.receipts=undefined;summary.patient={};f.sync();
 assert.equal(payment.querySelector('[data-visit-collect]'),null);
 assert.match(payment.textContent,/Copay not confirmed/);
 f.w.activeVisit.status='signed';summary.account.status='posted';summary.patient.owes_now_cents=0;f.sync();
 assert.match(payment.textContent,/No patient amount due/);
 assert(details.open&&details.contains(ledger));
 f.dom.window.close();
}
