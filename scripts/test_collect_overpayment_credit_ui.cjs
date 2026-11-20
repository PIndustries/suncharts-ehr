// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The collect window's success panel must say what the server actually does with an amount
// above what the encounter owed: src/billing.rs allocate_copays caps applied money at the
// posted balance, so the extra stays an unapplied receipt — credit on the patient's account.
// The test drives the real path: open the session with owedAtOpen (as openCollectModal does),
// take parts through collectPartTaken, and read what the slot received.
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
 // The same session shape openCollectModal builds: owes_now_cents frozen as owedAtOpen.
 const open=owes=>vm.runInContext(`(owes=>{collectDialog={dataset:{},querySelector:()=>null,isConnected:true};collectSession={target:Number.isSafeInteger(owes)&&owes>0?owes:null,owedAtOpen:Number.isSafeInteger(owes)&&owes>0?owes:0,taken:[],group:'group-1'};})(${owes===null?'null':owes});`,ctx);
 const take=(amount,label,receipt)=>vm.runInContext('collectPartTaken',ctx)(amount,label,receipt,'appointment');
 return {ctx,slot,open,take};
};

// Owed $10.00 on the encounter, $30.00 card on the reader taken: the extra is named.
{
 const {slot,open,take}=load();
 open(1000);
 take(3000,'card on the reader',{id:'receipt-1'});
 assert.match(slot.innerHTML,/\$30\.00 card on the reader recorded/,'headline names the tender');
 assert.match(slot.innerHTML,/\$20\.00 more than this encounter owed stays as credit on the patient's account\./,'the extra alone is named as credit on the patient account');
 assert.doesNotMatch(slot.innerHTML,/goes to this encounter/,'the old sentence is not shown when the amount is over what was owed');
 assert.doesNotMatch(slot.innerHTML,/It is not owed money/,'no second sentence');
 assert.doesNotMatch(slot.innerHTML,/-\$|negative/,'nothing implies a negative balance');
 assert.match(slot.innerHTML,/data-collect-receipt="group-1"/,'the combined receipt button stays');
}
// Nothing was owed and $20.00 was taken.
{
 const {slot,open,take}=load();
 open(0);
 take(2000,'card on the reader',{id:'receipt-1'});
 assert.match(slot.innerHTML,/\$20\.00 stays as credit on the patient's account\. This encounter owed nothing\./,'zero-owed wording names the whole amount as credit');
 assert.doesNotMatch(slot.innerHTML,/more than this encounter owed/,'no extra figure when nothing was owed');
}
// Within what was owed: the old sentence stays.
{
 const {slot,open,take}=load();
 open(3000);
 take(3000,'cash',{id:'receipt-1'});
 assert.match(slot.innerHTML,/The payment goes to this encounter's balance\./,'the old sentence stays within what was owed');
 assert.doesNotMatch(slot.innerHTML,/credit on the patient/,'no credit wording when nothing is left over');
}
// Parts: exact total still reads as within what was owed; the last part closes the window.
{
 const {slot,open,take}=load();
 open(3000);
 take(2000,'card on the reader',{id:'receipt-1'});
 assert.match(slot.innerHTML,/\$10\.00 left to pay\. Choose how to take the rest above\./,'an unfinished part asks for the rest');
 take(1000,'cash',{id:'receipt-2'});
 assert.match(slot.innerHTML,/\$30\.00 paid in 2 parts/);
 assert.match(slot.innerHTML,/The payment goes to this encounter's balance\./);
 assert.doesNotMatch(slot.innerHTML,/credit on the patient/);
}
// Parts that overshoot the target name only the extra over what was owed.
{
 const {slot,open,take}=load();
 open(3000);
 take(2000,'card on the reader',{id:'receipt-1'});
 take(1500,'cash',{id:'receipt-2'});
 assert.match(slot.innerHTML,/\$35\.00 paid in 2 parts/);
 assert.match(slot.innerHTML,/\$5\.00 more than this encounter owed stays as credit on the patient's account\./,'parts name the extra over the frozen owed figure, not over the target');
}
// No target was set because nothing was owed: taking money is credit, stated as such.
{
 const {slot,open,take}=load();
 open(null);
 take(2000,'cash',{id:'receipt-1'});
 assert.match(slot.innerHTML,/\$20\.00 stays as credit on the patient's account\. This encounter owed nothing\./,'money taken with nothing owed is credit, not a payment on a balance');
}
// "Left to pay" never renders a negative after an overpayment, whether the owed figure was
// $0 or nothing was recorded for this encounter at all.
{
 const {ctx,open}=load();
 open(1000);
 vm.runInContext(`collectSession.taken.push({amount:2000,label:'card on the reader'});`,ctx);
 assert.match(vm.runInContext('collectProgressMarkup()',ctx),/<span>Left to pay<\/span><b>\$0\.00<\/b>/,'left to pay floors at zero, never -$20.00');
 assert.doesNotMatch(vm.runInContext('collectProgressMarkup()',ctx),/-\$/,'no negative amount anywhere in the progress panel');
 open(null);
 vm.runInContext(`collectSession.target=0;collectSession.taken.push({amount:2000,label:'card on the reader'});`,ctx);
 assert.match(vm.runInContext('collectProgressMarkup()',ctx),/<span>Left to pay<\/span><b>\$0\.00<\/b>/,'a target set to zero after opening still floors at zero');
 open(1000);
 vm.runInContext(`collectSession.taken.push({amount:2500,label:'cash'});`,ctx);
 assert.match(vm.runInContext('collectProgressMarkup()',ctx),/<span>Left to pay<\/span><b>\$0\.00<\/b>/);
}
console.log('PASS collect success: overpayment reads as credit on the patient account through the real collectPartTaken path, within-owed keeps the old sentence, left to pay never goes negative');
