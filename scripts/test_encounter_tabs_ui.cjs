// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The encounter page is in tabs: Note, Billing, Payments, Checkout, History. Which tab opens, what is
// remembered, the claim under the codes on Billing, and that the whole page follows the tab. Synthetic data only.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','web','patient-revenue.js'),'utf8');
const start=source.indexOf('const invoiceTabs='),end=source.indexOf("document.addEventListener('click',event=>{const tab=event.target?.closest?.('[data-invoice-tab-key]')");
assert.ok(start>0&&end>start,'the tab code is where this test expects it');
const store={},el=()=>({dataset:{},hidden:true,querySelectorAll:()=>[]});
const nodes={'encounter-revenue':el(),'visit-page-host':el(),'encounter-claims':el()};
const ctx={$:id=>nodes[id]||null,localStorage:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=String(v);}},activeVisit:{id:'visit-1'},encounterSection:'visit',
 encounterRevenueState:{data:{summary:{}}},encounterChargeAccount:()=>({status:'draft'}),renderEncounterInvoices(){},run(){},billingCan:()=>false};
vm.createContext(ctx);vm.runInContext(source.slice(start,end)+';this.tabs=invoiceTabs;this.remembered=invoiceTabRemembered;this.set=invoiceTabSet;this.forget=encounterTabForget;',ctx);
assert.deepEqual(JSON.parse(JSON.stringify(ctx.tabs.map(([,label])=>label))),['Note','Billing','History']);
// An encounter being written opens on its note; the visit summary and follow-up close the note.
assert.equal(ctx.remembered(),'note');ctx.encounterSection='checkout';assert.equal(ctx.remembered(),'note','the visit summary and follow-up sit at the end of the note');
// Billing opens on the billing tab used last; the old name of the codes tab still works.
ctx.encounterSection='charges';assert.equal(ctx.remembered(),'billing');
for(const old of ['encounter','codes','claim']){store['suncharts.invoiceTab']=old;assert.equal(ctx.remembered(),'billing',old);}
for(const old of ['invoices','payments']){store['suncharts.invoiceTab']=old;assert.equal(ctx.remembered(),'billing',old+' is a section of Billing');}
ctx.set('history');assert.equal(store['suncharts.invoiceTab'],'history');
// The page follows the tab, and the same encounter keeps its tab while it is re-drawn.
assert.equal(nodes['visit-page-host'].dataset.encounterTab,'history');assert.equal(nodes['encounter-revenue'].dataset.invoiceTab,'history');
ctx.set('note');assert.equal(ctx.remembered(),'note','re-drawing keeps the open tab');assert.equal(store['suncharts.invoiceTab'],'history','the note is not remembered as a billing tab');
// Another encounter opens fresh: billing comes back on the billing tab used last.
ctx.activeVisit={id:'visit-2'};assert.equal(ctx.remembered(),'history');
ctx.activeVisit={id:'visit-1'};ctx.forget();assert.equal(ctx.remembered(),'history','opening billing again forgets the note tab');
// No claim yet: Billing says, under the codes, where the claim comes from.
ctx.set('billing');assert.match(nodes['encounter-claims'].innerHTML,/made from these codes when the charges are posted/);
// A patient without insurance has no claim at all.
nodes['encounter-claims']=el();ctx.encounterRevenueState={data:{summary:{insurance:{insured:false}}}};ctx.set('billing');assert.equal(nodes['encounter-claims'].innerHTML,undefined);
// The page follows the tab in CSS: the note and checkout only on their tabs, money on Payments.
const css=fs.readFileSync(path.join(__dirname,'..','web','visit-billing.css'),'utf8');
assert.match(css,/#visit-page-host\[data-encounter-tab\]:not\(\[data-encounter-tab="note"\]\)>#visit-editor\{display:none\}/);
assert.match(css,/#visit-page-host\[data-encounter-tab\]:not\(\[data-encounter-tab="note"\]\)>#visit-checkout\{display:none\}/);
assert.match(css,/:not\(\[data-invoice-tab="payments"\]\):not\(\[data-invoice-tab="billing"\]\) #encounter-revenue-status \.visit-billing-breakdown\{display:none\}/,'what is owed shows on Billing and Payments');
// Billing reads top to bottom like one encounter form: the next step and the claim come last.
assert.match(css,/#encounter-revenue\[data-invoice-tab="billing"\]>#encounter-revenue-status\{order:4/);assert.match(css,/#encounter-revenue\[data-invoice-tab="billing"\]>#encounter-claims\{order:5\}/);
console.log('PASS encounter tabs: note while writing, billing tab remembered, whole page follows the tab');
