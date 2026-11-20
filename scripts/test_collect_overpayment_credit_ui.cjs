// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The collect window's success panel must say what the server actually does with an amount
// above what the encounter owed: src/billing.rs allocate_copays caps applied money at the
// posted balance, so the extra stays an unapplied receipt — credit on the patient's account.
const load=()=>{
 const slot={innerHTML:''};
 const ctx={console,Date,Intl,Math,Number,String,JSON,Array,Set,Map,URL,encodeURIComponent,
  esc,money:n=>'$'+(n/100).toFixed(2),dollars:n=>n==null?'':`${Math.trunc(n/100)}.${String(n%100).padStart(2,'0')}`,
  crypto:{randomUUID:()=>'group-1'},
  document:{addEventListener(){},querySelector:()=>null,createElement:()=>({setAttribute(){}})},
  $:id=>id==='encounter-hosted-copay-reader'?slot:null,
  encounterRevenueState:{patient:null,data:null},activeVisit:null,selected:'patient'};
 vm.createContext(ctx);
 vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
 return {ctx,slot};
};
const open=(ctx,target,taken)=>vm.runInContext(`collectDialog={dataset:{},querySelector:()=>null,isConnected:true};collectSession={target:${target},taken:[${taken.map(p=>`{amount:${p.amount},label:${JSON.stringify(p.label)}}`).join(',')}],group:'group-1'};`,ctx);
const takenCents=taken=>taken.reduce((sum,part)=>sum+part.amount,0);
const done=(ctx,amount,label,taken,target)=>vm.runInContext('collectDoneMarkup',ctx)(amount,label,'',takenCents(taken),target,taken.length);

// Overpayment: owed $0.00, $20.00 card on the reader taken.
{
 const {ctx,slot}=load();
 const html=done(ctx,2000,'card on the reader',[{amount:2000}],0);
 assert.match(html,/\$20\.00 card on the reader recorded/,'headline names the tender');
 assert.match(html,/\$20\.00 is more than this encounter owed and stays as credit on the patient's account\./,'the extra is named as credit on the patient account');
 assert.doesNotMatch(html,/goes to this encounter/,'the old sentence is not shown when the amount is over what was owed');
 assert.doesNotMatch(html,/-\$|negative/,'nothing implies a negative balance');
}
// Within what was owed: the old sentence stays.
{
 const {ctx}=load();
 const html=done(ctx,3000,'cash',[{amount:3000}],3000);
 assert.match(html,/The payment goes to this encounter's balance\./,'the old sentence stays within what was owed');
 assert.doesNotMatch(html,/credit on the patient/,'no credit wording when nothing is left over');
 // Parted payments against a target: exact total still reads as within what was owed.
 const exact=done(ctx,1000,'cash',[{amount:2000},{amount:1000}],3000);
 assert.match(exact,/The payment goes to this encounter's balance\./);
 assert.match(exact,/\$30\.00 paid in 2 parts/);
 // Parts that overshoot the target name the credit too.
 assert.match(done(ctx,1500,'cash',[{amount:2000},{amount:1500}],3000),/\$35\.00 is more than this encounter owed and stays as credit on the patient's account\./);
 // No target was set (nothing was owed or recorded): nothing claims a credit exists.
 assert.match(done(ctx,2000,'cash',[{amount:2000}],null),/The payment goes to this encounter's balance\./,'no recorded target claims a credit unprompted');
}
// "Left to pay" never renders a negative after an overpayment.
{
 const {ctx}=load();
 open(ctx,0,[{amount:2000,label:'card on the reader'}]);
 const html=vm.runInContext('collectProgressMarkup()',ctx);
 assert.match(html,/<span>Left to pay<\/span><b>\$0\.00<\/b>/,'left to pay floors at zero, never -$20.00');
 assert.doesNotMatch(html,/-\$/,('no negative amount anywhere in the progress panel'));
 open(ctx,1000,[{amount:2500,label:'cash'}]);
 assert.match(vm.runInContext('collectProgressMarkup()',ctx),/<span>Left to pay<\/span><b>\$0\.00<\/b>/);
}
console.log('PASS collect success: overpayment reads as credit on the patient account, within-owed keeps the old sentence, left to pay never goes negative');
