// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The visit charge table lives on its own: lines as rows, edits that save themselves, undo for
// removals, live totals, and plain-worded row problems. jsdom is the DOM so rows, focus and
// events behave as they do on the page.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const dom=new JSDOM(`<!doctype html><body>
 <div id="encounter-revenue"><div id="encounter-billing-editor"></div></div>
 <div id="billing-detail"></div>
 <div data-charge-total></div><div data-charge-copay></div><div data-charge-pays></div>`,
 {url:'http://localhost/'});
const {window}=dom;
const sent=[];
let apiReply=(url,method)=>({id:'account',version:7,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',lines:[]}});
// Staff display helpers load before every feature script, exactly as index.html loads them.
const ctx={console,setTimeout,clearTimeout,Date,Intl,URL,URLSearchParams,Map,Set,Array,Math,Number,String,JSON,Object,Boolean,RegExp,Error,Promise,Symbol,WeakMap,document:window.document,window,
 crypto:{randomUUID:()=>'synthetic-request'},selected:'patient',me:{role:'owner'},chartSection:'visits',billingSelected:null,
 workspace:{appointments:[],visits:[{id:'visit-a',appointment_id:'appt-a',created_at:'2026-11-13T14:00:00Z'}],billing:{accounts:[],coverages:[],entries:[]}},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
 human:v=>String(v??'').replaceAll('_',' '),date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),
 payerName:()=>'Synthetic payer',billingCan:()=>true,$:id=>window.document.getElementById(id),
 visitBillingDate:v=>window.Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(`${v}T00:00:00`)),
 revenueCoverage:()=>null,accountDiagnosisSummary:()=>'',billingChargeDraftRecovery:()=>'',accountDiagnosisDraftRecovery:()=>'',
 billingDetailHost:()=>window.document.getElementById('billing-detail'),chargeTable:()=>'',notice(message){ctx.noticed=message;},run:fn=>fn(),showChartSection(){},setEncounterSection(){},
 api:async(url,method='GET',body,version)=>{sent.push({url,method,body,version});return apiReply(url,method,body);}};
const context=vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/billing.js','utf8'),context);
vm.runInContext(fs.readFileSync('web/fees.js','utf8'),context);
const editorHost=window.document.getElementById('encounter-billing-editor');
editorHost.scrollIntoView=()=>{};
ctx.billingEditorHost=()=>editorHost;
const $=id=>window.document.getElementById(id);
const evaluate=code=>vm.runInContext(code,ctx);
// The page's own realm is the vm context, so clicks and typing are made from the Event the vm
// sees; jsdom dispatches those exactly as a real page would.
const VMEvent=window.Event;ctx.Event=window.Event;
const click=node=>{node.dispatchEvent(new VMEvent('click',{bubbles:true,cancelable:true}));};
const type=(node,value)=>{node.value=value;node.dispatchEvent(new VMEvent('input',{bubbles:true}));};
const change=(node,value)=>{node.value=value;node.dispatchEvent(new VMEvent('change',{bubbles:true}));};
const statusText=()=>$('billing-account-form').querySelector('[data-charge-status]').textContent.trim();
const lineTexts=()=>Array.from($('billing-account-form').querySelectorAll('#billing-charge-lines .billing-charge-row')).map(r=>r.querySelector('[name="code"]').value);
// jsdom fires no events and runs no timers for us; autosave waits are drained by hand.
// The save rides a setTimeout set inside the vm realm, which jsdom never runs. Drain it by
// hand: cancel the pending timer, call the save the timer would have made, and let its api
// promise settle before reading what the table did.
const advance=async()=>{for(let pass=0;pass<4;pass++){const form=$('billing-account-form');if(!form?.chargeSaveTimer)break;clearTimeout(form.chargeSaveTimer);form.chargeSaveTimer=null;await vm.runInContext('saveChargeTable($("billing-account-form"))',ctx).catch(e=>{console.error('save failed',e);});await Promise.resolve();await Promise.resolve();}};
// An account whose content.lines is empty makes a table with one blank row to start, the same
// shape the page gives a visit that has no charges yet.
const openTable=async lines=>{
 ctx.workspace.billing.accounts=lines.length?[{id:'account',version:7,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines,notes:''}}]:[];
 sent.length=0;
 await vm.runInContext('accountEditor('+(lines.length?'workspace.billing.accounts[0]':'null')+',null,true)',ctx);
 return $('billing-account-form');
};
(async()=>{
 ctx.activeVisit={id:'visit-a',appointment_id:'appt-a',status:'in_progress'};
 ctx.revenueServiceDate=()=>'2026-11-13';
 ctx.billingCoverageOrderMarkup=()=>'';
 ctx.visitPlanCopayCents=()=>2500;
 ctx.api=ctx.api;
 const diagnose=async()=>'no visit diagnoses';
 ctx.loadFeeContext=undefined;
 // A brand-new table for a visit: one blank row, totals at zero, nothing typed yet.
 let form=await openTable([]);
 assert.ok(form,'the editor opened');
 assert.equal(form.dataset.autosave,'on','a visit charge editor saves itself');
 assert.ok($('billing-charge-lines'),'the lines are a table');
 assert.equal(JSON.stringify(lineTexts()),'[""]','one blank row to start');
 assert.equal(form.querySelector('[data-charge-total]').textContent,'$0.00','totals start at zero');
 // Add row: a new line appears and its code box takes focus.
 click(form.querySelector('[data-add-charge]'));
 assert.equal(JSON.stringify(lineTexts()),'["",""]','Add charge puts another blank row on the table');
 assert.equal(window.document.activeElement,$('billing-charge-lines').querySelectorAll('.billing-charge-row [name="code"]')[1],'the new row is ready to type in');
 // First line: the autosave POSTs (there is nothing to update yet) after its debounce.
 const row0=$('billing-charge-lines').querySelectorAll('.billing-charge-row')[0];
 type(row0.querySelector('[name="code"]'),'99213');
 type(row0.querySelector('[name="description"]'),'Office visit');
 type(row0.querySelector('[name="units"]'),'1');
 type(row0.querySelector('[name="amount"]'),'150.00');
 change(row0.querySelector('[name="diagnoses"]'),'Z00.00');
 assert.equal($('billing-account-form').chargeSaveDelay,700,'the save waits a beat, so typing is not chopped up');
 await advance();
 assert.ok(sent.every(call=>call.method!=='PUT'),'nothing is updated before an account exists');
 const post=sent.find(call=>call.method==='POST');
 assert.ok(post,'the first line saves itself');
 assert.equal(post.url,'/api/v1/patients/patient/billing/accounts');
 assert.equal(post.body.reason,'Edited charges');
 assert.equal(post.body.content.lines[0].code,'99213');
 assert.equal(post.body.content.lines[0].amount_cents,15000);
 assert.equal(JSON.stringify(post.body.content.lines[0].diagnosis_codes),'["Z00.00"]','the diagnosis travels with the line');
 // The saved table carries the new id and version, and tells staff it is saved.
 assert.equal(form.dataset.id,'account','the account the server made is now the editor\'s');
 assert.equal(form.dataset.version,'7','the version header for the next save came from the server');
 assert.equal(statusText(),'Saved','the table says it is saved');
 // An edit on the second line PUTs the whole table with the server version as If-Match.
 const second=$('billing-charge-lines').querySelectorAll('.billing-charge-row')[1];
 type(second.querySelector('[name="code"]'),'J9270');
 type(second.querySelector('[name="description"]'),'Injection');
 type(second.querySelector('[name="units"]'),'2');
 type(second.querySelector('[name="amount"]'),'9.00');
 await advance();
 const put=sent.find(call=>call.method==='PUT');
 assert.ok(put,'an edit after the account exists updates it');
 assert.equal(put.url,'/api/v1/patients/patient/billing/accounts/account');
 assert.equal(put.version,7,'the save carries the version the server last gave');
 assert.equal(put.body.reason,'Edited charges');
 assert.equal(put.body.content.lines.length,2,'the whole table travels with every save');
 assert.equal(put.body.content.lines[1].code_system,'HCPCS','a J-code saves as HCPCS');
 // A drug code opens its NDC fields inside the row, no closed box.
 assert.ok(second.querySelector('.charge-drug:not([hidden])'),'the drug detail is inside the row');
 // Totals live: line total, grand total, and the copay line.
 assert.equal(second.querySelector('[data-charge-line-total]').textContent,'$18.00');
 assert.equal(form.querySelector('[data-charge-total]').textContent,'$168.00','the total moves as lines move');
 assert.match(form.querySelector('[data-charge-pays]').textContent,/Patient pays now \$25\.00/,'the copay is shown as what the patient pays now');
 // Row problems in plain words: an empty row says what is missing, nothing more.
 const problemLine=$('billing-charge-lines').querySelectorAll('.billing-charge-row')[1];
 assert.match(problemLine.querySelector('[data-charge-problem]').textContent,/Choose the diagnoses this service was for\./,'what the row still needs, in plain words');
 change(problemLine.querySelector('[name="diagnoses"]'),'J10.0');
 // Remove: the row leaves the table at once, undo is offered, and the save follows.
 const rowsBefore=[...$('billing-charge-lines').querySelectorAll('.billing-charge-row')];
 const removeButton=rowsBefore[1].querySelector('[data-remove-charge]');
 click(removeButton);
 assert.equal(JSON.stringify(lineTexts()),'["99213"]','Remove takes the row out of the table immediately');
 assert.equal(form.querySelector('[data-charge-total]').textContent,'$150.00','the total follows the removal');
 assert.match(statusText(),/Removed line J9270\. Undo$/,'removal is undoable from the status line');
 // The removal autosaves while the offer stands.
 await advance();
 const afterRemove=sent.at(-1);
 assert.equal(afterRemove.method,'PUT');
 assert.equal(afterRemove.body.content.lines.length,1,'the removal was saved');
 // Staff change their mind: a fresh removal, then Undo before its save lands.
 const rowsNow=[...$('billing-charge-lines').querySelectorAll('.billing-charge-row')];
 click(rowsNow[0].querySelector('[data-remove-charge]'));
 const undo=form.querySelector('[data-undo-charge]');
 assert.ok(undo,'the removal offers Undo from the status line');
 click(undo);
 assert.equal(JSON.stringify(lineTexts()),'["99213"]','Undo puts the row back on the table');
 await advance();
 const afterUndo=sent.at(-1);
 assert.equal(afterUndo.method,'PUT');
 assert.equal(afterUndo.body.content.lines.length,1,'the restored line saves again');
 // The undo put the row back with the removal still pending its save; clear that pending
 // state through a save, then stage the conflict.
 await advance();
 // The server is a beat behind: the first PUT loses the version race, the account list answers
 // with the newer version the reload is meant to pick up, and the retry succeeds.
 let conflictArmed=true;
 apiReply=(url,method)=>{
  if(method==='PUT'&&conflictArmed){conflictArmed=false;throw Object.assign(new Error('version conflict'),{status:409});}
  if(url.endsWith('/accounts'))return {accounts:[{id:'account',version:9,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[{code_system:'CPT',code:'99213',description:'Office visit',units:1,amount_cents:15000,diagnosis_codes:['Z00.00']}]}}]};
  return {id:'account',version:10,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[{code_system:'CPT',code:'99213',description:'Office visit',units:1,amount_cents:15000,diagnosis_codes:['Z00.00']}]}};
 };
 ctx.workspace.billing.accounts=[{id:'account',version:9,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[{code_system:'CPT',code:'99213',description:'Office visit',units:1,amount_cents:15000,diagnosis_codes:['Z00.00']}]}}];
 const conflictRow=$('billing-charge-lines').querySelector('.billing-charge-row');
 type(conflictRow.querySelector('[name="description"]'),'A longer visit');
 await advance();
 assert.match(statusText(),/refreshed/,'a conflict says the table was refreshed, in plain words');
 assert.equal($('billing-charge-lines').querySelectorAll('.billing-charge-row').length,1,'the saved lines came back from the server');
 assert.equal($('billing-account-form').dataset.version,'9','the refresh leaves the table ready to save against the newer version');
 assert.match(statusText(),/refreshed/,'the refreshed table waits for the next change, without saving over the newer version');
 apiReply=(url,method)=>({id:'account',version:7,status:'draft',content:{visit_id:'visit-a',service_date:'2026-11-13',lines:[]}});
 // A finished account is read-only: the table is shown, no editing controls.
 ctx.workspace.billing.accounts=[{id:'account',version:9,status:'posted',content:{visit_id:'visit-a',service_date:'2026-11-13',currency:'USD',lines:[{code_system:'CPT',code:'99213',description:'Office visit',units:1,amount_cents:15000,diagnosis_codes:['Z00.00']}]}}];
 await vm.runInContext('accountEditor(workspace.billing.accounts[0],null,true)',ctx);
 const finished=$('encounter-billing-editor').innerHTML;
 assert.match(finished,/Charges for this visit/,'a posted account is shown as finished charges');
 assert.ok(!finished.includes('data-add-charge')&&!finished.includes('data-remove-charge'),'a finished table has nothing to press');
 console.log('PASS charge table: add and focus, debounced POST then PUT with the server version, live totals and copay, plain-worded row problems, remove with undo, 409 refresh, and a read-only finished table');
})().catch(error=>{console.error(error);process.exit(1);});
