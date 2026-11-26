// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
// The screens are loaded the way the browser loads them: the picker first, then the screen that
// registers its records with it, so a type-ahead box on any of them resolves the same way.
const PICKER_SRC=require('fs').readFileSync('web/typeahead.js','utf8');
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);vm.runInContext(PICKER_SRC,context);return context;};}

const handlers={},nodes=new Map(),calls=[];
let html='',pending;
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',elements:{document_text:{value:''},original_text:{value:''}},querySelectorAll:()=>[]});return nodes.get(id);};
const detail={remittance:{id:'era',payer_id:'payer',trace:'SYNTHETIC',status:'posted',version:3,document_hash:'a'.repeat(64),matches:[],document:{payer_code:'SYN',payment_date:'2026-10-01',total_paid_cents:8000,currency:'USD',claims:[],supplemental:[{segment:'AMT',elements:['B6','100'],claim_index:0,service_index:0}]}},postings:[{claim_id:'claim',account_id:'account',patient_responsibility_cents:2000,writeoff_cents:2550,current_account_balance_cents:-1000}]};
const context={console,Map,JSON,Number,Date,Error,crypto:{randomUUID:()=> 'request'},document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn)},$:node,esc:v=>String(v??'').replaceAll('<','&lt;'),human:v=>v,date:v=>v,money:v=>'$'+(v/100).toFixed(2),billingWrite:()=>true,payerName:()=> 'Synthetic payer',billingPayers:[],selectField:()=>'',
  // The insurance company box is typed into; this harness draws the pair the form submits.
  payerPickerMarkup:(name,label,opts={})=>`<label>${label}<input type="text" name="${name}_name" value="${String(opts.value||'')}"><input type="hidden" name="${name}_id" value=""></label>`,billingField:()=>'',sourceNotice:()=>'',showProviderSettlement:async()=>{},run:fn=>pending=fn(),api:async(path,method='GET')=>{calls.push({path,method});return path.endsWith('/history')?{items:[]}:detail;}};
vm.createContext(context);vm.runInContext(fs.readFileSync('web/claims.js','utf8'),context);vm.runInContext(fs.readFileSync('web/era-batches.js','utf8'),context);
context.claimPane=value=>html=value;context.claimHistory=()=>'';
(async()=>{
 await context.showEra('era');
 assert.match(html,/Current account balance/);assert.match(html,/\$10\.00 patient credit/);assert.doesNotMatch(html,/-\$?10\.00 open/);
 assert.match(html,/Other amounts from the payer \(1\)/);assert.match(html,/do not add payments or patient charges/);assert.match(html,/B6/);
 assert(calls.every(c=>c.method==='GET'));
 // Switching payments while provider adjustments are loading must leave each form bound to its own remittance.
 const scopedDetail=id=>({...detail,remittance:{...detail.remittance,id,trace:id,status:'reconciled',version:id==='first'?4:7,matches:[{row_index:0,claim_id:id+'-claim'}]},issues:[],ready_to_post:true});
 let releaseSettlement,latest,future;const writes=[];
 context.claimPane=value=>{html=value;const row={dataset:{row:'0'}};latest={row,form:{id:'era-matches',querySelectorAll:()=>[row]},action:{id:'era-action'}};nodes.set('era-matches',latest.form);nodes.set('era-action',latest.action);};
 context.api=async(url,method='GET',body,version)=>{if(method!=='GET'){writes.push({url,method,body,version});return new Promise(resolve=>{future=resolve;});}return url.endsWith('/history')?{items:[]}:scopedDetail(url.split('/').at(-1));};
 context.showProviderSettlement=async id=>{if(id==='first')await new Promise(resolve=>{releaseSettlement=resolve;});};
 const first=context.showEra('first');await new Promise(resolve=>setImmediate(resolve));const previous=latest;
 await context.showEra('second');const second=latest;releaseSettlement();await first;
 assert.equal(previous.row.reviewedMatch.claim_id,'first-claim');assert.equal(second.row.reviewedMatch.claim_id,'second-claim');assert.equal(previous.action.viewCurrent(),false);
 context.FormData=class{constructor(form){return Object.entries(form.values||{});}};
 const submit=form=>{for(const handler of handlers.submit)handler({target:form,preventDefault(){}});return pending;};
 previous.action.values={action:'post',reason:'Synthetic approval'};await assert.rejects(submit(previous.action),/Open the payment again/);assert.equal(writes.length,0);
 second.action.values={action:'post',reason:'Synthetic approval'};const posting=submit(second.action);
 await context.showEra('third');future();await posting;
 assert.deepEqual(JSON.parse(JSON.stringify(writes)),[{url:'/api/v1/billing/remittances/second/actions',method:'POST',body:{action:'post',reason:'Synthetic approval'},version:7}]);assert.match(html,/third/);
 console.log('PASS delayed ERA reads leave reviewed matches, posting and navigation bound to the selected payment');
 context.eraImportEditor();assert.match(html,/maxlength="1048576"/);assert.match(html,/1,000 claim rows/);
 const accepted={id:'era-file',files:[{size:80000,text:async()=> 'SYNTHETIC-LARGE-FILE'}]};
 for(const handler of handlers.change)handler({target:accepted});await pending;
 assert.equal(node('era-import').elements.document_text.value,'SYNTHETIC-LARGE-FILE');
 for(const handler of handlers.change)handler({target:{id:'era-file',files:[{size:1048577,text:async()=>{throw new Error('Oversized input must not be read');}}]}});
 await assert.rejects(pending,/larger than 1 MB/);
 await context.beginEraBatch();assert.match(html,/100 transactions \/ 1 MiB/);
 for(const handler of handlers.change)handler({target:{id:'era-batch-file',files:[{size:80000,text:async()=> 'SYNTHETIC-BATCH'}]}});await pending;
 assert.equal(node('era-batch-preview').elements.original_text.value,'SYNTHETIC-BATCH');
 console.log('ERA current patient credit, retained evidence, read-only review and larger file UI: passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
