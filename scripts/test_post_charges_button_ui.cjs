// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// The action travels on the pressed button. FormData built from the form alone never contains it,
// so the submit listener must read event.submitter; otherwise pressing "Post charges" on a signed
// visit with draft charges fails with "Choose the action to record." and nothing happens.
const handlers={},calls=[];
const account={id:'account',status:'draft',version:4,content:{visit_id:'visit'}};
const ctx={console,JSON,Object,Array,String,Number,Math,Boolean,Symbol,Reflect,Promise,Error,
 me:{role:'owner'},selected:'patient',chartSection:'visits',activeVisit:{id:'visit',status:'signed'},
 workspace:{billing:{accounts:[account]}},
 document:{addEventListener:(name,fn)=>{(handlers[name]??=[]).push(fn);}},
 $:()=>null,esc:v=>String(v??''),notice(){},selectPatient:async()=>{},showChartSection:()=>{},
 run:async fn=>{ctx.last=Promise.resolve().then(fn).catch(e=>{ctx.lastError=e;});return ctx.last;},
 api:async(...args)=>{calls.push(args);return account;}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);
// Render the real action form for a draft account on a signed visit, then submit it with only the
// reason field on the form; the pressed button is supplied solely through event.submitter.
const html=ctx.billingAccountActionForm(account,false,'Reason','helper','Post charges','Remove these charges','local only');
assert.match(html,/<form id="billing-account-action"/,'the action form renders');
assert.match(html,/<button type="submit" class="primary" name="action" value="post">Post charges<\/button><button type="submit" name="action" value="void">Remove these charges<\/button>/,'both action buttons carry name and value');
const form={id:'billing-account-action',dataset:{account:'account',version:'4'},querySelectorAll:()=>[],closest:()=>null};
function submit(submitter){ctx.FormData=class{constructor(){const entries=[['reason','Charges reviewed']];this[Symbol.iterator]=entries[Symbol.iterator].bind(entries);}};
 for(const handler of handlers.submit||[])handler({target:form,submitter,preventDefault(){}});return ctx.last;}
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
 await submit(undefined);
 assert.equal(calls.filter(c=>String(c[0]).endsWith('/actions')).length,2,'no action means no request');
 assert.equal(ctx.lastError?.message,'Choose the action to record.');
 console.log('PASS post/void charges read the pressed submitter button; a submit with no action still stops');
})().catch(error=>{console.error(error);process.exitCode=1;});
