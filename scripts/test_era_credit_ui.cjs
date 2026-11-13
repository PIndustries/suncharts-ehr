// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers={},nodes=new Map(),calls=[];
let html='',pending;
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',elements:{document_text:{value:''},original_text:{value:''}},querySelectorAll:()=>[]});return nodes.get(id);};
const detail={remittance:{id:'era',payer_id:'payer',trace:'SYNTHETIC',status:'posted',version:3,document_hash:'a'.repeat(64),matches:[],document:{payer_code:'SYN',payment_date:'2026-10-01',total_paid_cents:8000,currency:'USD',claims:[],supplemental:[{segment:'AMT',elements:['B6','100'],claim_index:0,service_index:0}]}},postings:[{claim_id:'claim',account_id:'account',patient_responsibility_cents:2000,writeoff_cents:2550,current_account_balance_cents:-1000}]};
const context={console,Map,JSON,Number,Date,Error,crypto:{randomUUID:()=> 'request'},document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn)},$:node,esc:v=>String(v??'').replaceAll('<','&lt;'),human:v=>v,date:v=>v,money:v=>'$'+(v/100).toFixed(2),billingWrite:()=>true,payerName:()=> 'Synthetic payer',billingPayers:[],selectField:()=>'',billingField:()=>'',sourceNotice:()=>'',showProviderSettlement:async()=>{},run:fn=>pending=fn(),api:async(path,method='GET')=>{calls.push({path,method});return path.endsWith('/history')?{items:[]}:detail;}};
vm.createContext(context);vm.runInContext(fs.readFileSync('web/claims.js','utf8'),context);vm.runInContext(fs.readFileSync('web/era-batches.js','utf8'),context);
context.claimPane=value=>html=value;context.claimHistory=()=>'';
(async()=>{
 await context.showEra('era');
 assert.match(html,/Current account balance/);assert.match(html,/\$10\.00 patient credit/);assert.doesNotMatch(html,/-\$?10\.00 open/);
 assert.match(html,/Other amounts from the payer \(1\)/);assert.match(html,/do not add payments or patient charges/);assert.match(html,/B6/);
 assert(calls.every(c=>c.method==='GET'));
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
