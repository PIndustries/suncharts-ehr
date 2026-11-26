// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// The action travels on the pressed button. FormData built from the form alone never contains it,
// so the submit listener must read event.submitter; otherwise pressing "Post charges" on a signed
// visit with draft charges fails with "Choose the action to record." and nothing happens.
const handlers={},calls=[],notices=[];
const account={id:'account',status:'draft',version:4,content:{visit_id:'visit'}};
const ctx={console,JSON,Object,Array,String,Number,Math,Boolean,Symbol,Reflect,Promise,Error,
 me:{role:'owner'},selected:'patient',chartSection:'visits',activeVisit:{id:'visit',status:'signed'},
 workspace:{billing:{accounts:[account]}},
 document:{addEventListener:(name,fn)=>{(handlers[name]??=[]).push(fn);}},
 $:()=>null,esc:v=>String(v??''),notice:m=>notices.push(m),selectPatient:async()=>{},showChartSection:()=>{},
 run:async fn=>{try{await fn();ctx.pending.resolve();}catch(error){ctx.pending.reject(error);}},
 api:async(...args)=>{calls.push(args);return account;}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);
// Render the real action form for a draft account on a signed visit, then submit it with only the
// reason field on the form; the pressed button is supplied solely through event.submitter.
const html=ctx.billingAccountActionForm(account,false,'Reason','helper','Post charges','Remove these charges','local only');
assert.match(html,/<form id="billing-account-action"/,'the action form renders');
assert.match(html,/<button type="submit" class="primary" name="action" value="post">Post charges<\/button><button type="submit" name="action" value="void">Remove these charges<\/button>/,'both action buttons carry name and value');
const form={id:'billing-account-action',dataset:{account:'account',version:'4'},querySelectorAll:()=>[],closest:()=>null};
const chargeForm={id:'billing-account-form',dataset:{patient:'patient'},hasAttribute:()=>false,querySelectorAll:()=>[]};
function runSubmit(target,submitter,entries){const pending=Promise.withResolvers();ctx.pending=pending;
 ctx.FormData=class{constructor(){this[Symbol.iterator]=entries[Symbol.iterator].bind(entries);}};
 for(const handler of handlers.submit||[])handler({target,submitter,preventDefault(){}});return ctx.pending.promise;}
function submit(submitter){return runSubmit(form,submitter,[['reason','Charges reviewed']]);}
function submitCharges(){return runSubmit(chargeForm,undefined,[['reason','Charges reviewed'],['visit_id','visit'],['service_date','2026-01-05'],['notes',''],['coverage_id','']]);}
// A live table that somehow submits is stopped in plain words: it saves itself.
function submitLiveTable(){chargeForm.dataset.autosave='on';const e=runSubmit(chargeForm,undefined,[['reason','x'],['visit_id','visit'],['service_date','2026-01-05']]);chargeForm.dataset.autosave='off';return e;}
const actionCall=()=>calls.filter(c=>String(c[0]).endsWith('/actions')).at(-1);
(async()=>{
 await submit({name:'action',value:'post'});
 assert.equal(ctx.lastError,undefined,'post must not throw: '+(ctx.lastError?.message||''));
 assert.equal(actionCall()[0],'/api/v1/patients/patient/billing/accounts/account/actions');
 assert.equal(actionCall()[1],'POST');assert.equal(actionCall()[3],4);
 assert.equal(actionCall()[2].action,'post','the pressed post button reaches the request body');
 await submit({name:'action',value:'void'});
 assert.equal(ctx.lastError,undefined,'void must not throw: '+(ctx.lastError?.message||''));
 assert.equal(actionCall()[2].action,'void','the pressed void button reaches the request body');
 // With no submitter there is genuinely no action, and the review message still stops the call.
 const noActionError=await submit(undefined).catch(e=>e);
 assert.equal(calls.filter(c=>String(c[0]).endsWith('/actions')).length,2,'no action means no request');
 assert.equal(noActionError?.message,'Choose the action to record.');
 // The shared finisher must say what was saved, not "Insurance saved." for every form.
 notices.length=0;await submit({name:'action',value:'post'});
 assert.equal(notices.at(-1),'Charges posted.','posting charges says Charges posted.');
 notices.length=0;await submit({name:'action',value:'void'});
 assert.equal(notices.at(-1),'Charges removed.','removing charges says Charges removed.');
 const liveTableError=await submitLiveTable().catch(e=>e);
 assert.match(liveTableError?.message||'',/save as you edit/i,'a live table never submits; it says so in plain words');
 ctx.billingChargeMarkup=()=>'snapshot';
 chargeForm.dataset.autosave='off';
 notices.length=0;
 await submitCharges();
 assert.equal(ctx.lastError,undefined,'saving charges must not throw: '+(ctx.lastError?.message||''));
 assert.equal(notices.at(-1),'Charges saved.','saving charges says Charges saved.');
 const ledgerForm={id:'billing-ledger-form',dataset:{},querySelectorAll:()=>[]};
 function submitLedger(){return runSubmit(ledgerForm,undefined,[['kind','payment'],['amount','10.00'],['party','patient'],['method','cash'],['reference',''],['occurred_on','2026-01-05'],['reason','Payment received']]);}
 notices.length=0;
 await submitLedger();
 assert.equal(ctx.lastError,undefined,'ledger save must not throw: '+(ctx.lastError?.message||''));
 assert.equal(notices.at(-1),'Payment or adjustment saved.','a ledger entry says Payment or adjustment saved.');
 console.log('PASS post/void charges read the pressed submitter button, a submit with no action still stops, and each save names what it saved');
})().catch(error=>{console.error(error);process.exitCode=1;});
