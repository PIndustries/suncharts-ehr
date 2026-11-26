// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 const calls=[],pending=[],fields={amount:'12.00',reason:'Synthetic refund reason',method:'cash',account:'encounter-2'};
 const status={textContent:''},submit={disabled:false,textContent:''},listeners={};
 const form={saving:false,querySelector:s=>s==='button[type="submit"]'?submit:status,querySelectorAll:()=>[],addEventListener:(k,fn)=>listeners[k]=fn};
 const slot={innerHTML:'',querySelector:()=>form};
 const box={querySelector:()=>slot,querySelectorAll:()=>[]};
 const ctx=vm.createContext({console,URLSearchParams,Date,Number,crypto:{randomUUID:()=> 'synthetic-request'},document:{addEventListener(){}},FormData:class{*[Symbol.iterator](){yield* Object.entries(fields);}},billingCan:()=>true,dollars:n=>(n/100).toFixed(2),cents:s=>Math.round(Number(s)*100),money:n=>'$'+(n/100).toFixed(2),esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('"','&quot;'),displayDate:s=>s,run:fn=>pending.push(Promise.resolve().then(fn)),api:async(url,method,body)=>{calls.push({url,method,body});if(url.startsWith('/api/v1/billing/overview?'))return {patient:{id:'synthetic-patient'},accounts:{items:[{id:'encounter-2',status:'posted',patient_owes_now_cents:3000,service_date:'2026-11-25'}]}};return {status:'completed'};}});
 vm.runInContext(fs.readFileSync('web/payments.js','utf8'),ctx);
 return {ctx,calls,pending,box,slot,form,fields,status,submit,async send(){listeners.submit({preventDefault(){},stopImmediatePropagation(){}});await Promise.all(pending);}};
}
async function main(){
 const receipt={id:'synthetic-receipt',patient_id:'synthetic-patient',amount_cents:2000,allocated_cents:500,cash_refunded_cents:100,method:'cash',account_ids:['encounter-1']};
 let f=fixture();assert.match(f.ctx.receiptActionsMarkup(receipt),/>Refund</);assert.match(f.ctx.receiptActionsMarkup(receipt),/Apply credit to another encounter/);assert.equal(f.ctx.receiptCreditAmount(receipt),1400);
 await f.ctx.openReceiptAction(f.box,receipt,'refund',()=>true);assert.match(f.slot.innerHTML,/Pay the patient by cash or check first/);assert.match(f.slot.innerHTML,/Reason/);await f.send();
 let post=f.calls.find(c=>c.method==='POST');assert.equal(post.body.method,'cash');assert.equal(post.body.amount_cents,1200);assert.equal(post.body.reason,'Synthetic refund reason');assert.match(f.status.textContent,/Saved/);
 f=fixture();await f.ctx.openReceiptAction(f.box,receipt,'apply',()=>true);assert.match(f.slot.innerHTML,/encounter-2/);assert.match(f.calls[0].url,/patient_id=synthetic-patient/);await f.send();post=f.calls.find(c=>c.method==='POST');assert.equal(post.body.kind,'apply');assert.equal(post.body.account_id,'encounter-2');
 const card={...receipt,method:'external',cash_refunded_cents:0,hosted_checkout:{id:'synthetic-card-operation',livemode:false,refunded_cents:300,refunded_unapplied_cents:200}};
 f=fixture();await f.ctx.openReceiptAction(f.box,card,'refund',()=>true);assert.match(f.slot.innerHTML,/original card/);assert.match(f.slot.innerHTML,/17.00/);await f.send();assert.equal(f.calls.find(c=>c.method==='POST').body.method,'card');
 // Failed/uncertain responses keep the original command even if fields change.
 f=fixture();let tries=0;f.ctx.api=async(url,method,body)=>{f.calls.push({url,method,body:{...body}});if(!tries++)throw Error('Connection lost');return {status:'completed'};};
 await f.ctx.openReceiptAction(f.box,card,'refund',()=>true);await f.send();assert.match(f.status.textContent,/Retry uses the same request/);f.fields.amount='2.00';f.fields.reason='Changed after failure';await f.send();assert.deepEqual(f.calls[0].body,f.calls[1].body);
 // Reopening a pending refund uses the durable command from the server.
 f=fixture();const saved={request_id:'existing-request',kind:'refund',amount_cents:1200,reason:'Original reason',method:'card',account_id:null};
 await f.ctx.openReceiptAction(f.box,{...card,pending_actions:[saved]},'refund',()=>true);await f.send();assert.equal(f.calls.find(c=>c.method==='POST').body.request_id,'existing-request');assert.equal(f.calls.find(c=>c.method==='POST').body.reason,'Original reason');
 f=fixture();f.fields.amount='50.00';await f.ctx.openReceiptAction(f.box,receipt,'refund',()=>true);await f.send();assert(!f.calls.some(c=>c.method==='POST'));
 f=fixture();await f.ctx.openReceiptAction(f.box,receipt,'refund',()=>false);assert.equal(f.slot.innerHTML,'');
 f=fixture();f.ctx.api=async()=>({patient:{id:'other-patient'},accounts:{items:[]}});await assert.rejects(()=>f.ctx.openReceiptAction(f.box,receipt,'apply',()=>true),/do not belong/);
 f=fixture();f.ctx.billingCan=()=>false;assert.equal(f.ctx.receiptActionsMarkup(receipt),'');

 // The billing landing offers shortcuts without relying on another workspace's cached claim rows.
 vm.runInContext(fs.readFileSync('web/claims.js','utf8'),f.ctx);
 assert.match(f.ctx.billingClaimShortcuts(),/data-billing-claim-queue="send">Claims to send<\/button>/);
 assert.match(f.ctx.billingClaimShortcuts(),/data-billing-claim-queue="fix">Needs fixing<\/button>/);
 f.ctx.workspaceResourceAllowed=resource=>resource!=='claims';
 assert.equal(f.ctx.billingClaimShortcuts(),'');
 console.log('PASS refund and credit forms, original-card routing, reasons, exact retries, reopened pending requests, patient isolation and scoped claim shortcuts');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
