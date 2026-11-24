// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

// "Review and send" must always end with the review panel on screen: the encounter moves to its
// Billing tab first, and no stylesheet rule for the Billing tab hides the panel. Synthetic only.
const {visitSummary}=require('./visit_billing_fixture.cjs');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nodes={};
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},hidden:true,scrollIntoView(){this.scrolled=(this.scrolled||0)+1;},querySelector(){return null;},replaceChildren(){this.innerHTML='';}};
const handlers=[];
// The real tab switch rebuilds the billing markup: the panel element is a fresh, hidden one.
const rebuild=()=>{delete nodes['visit-billing-review'];node('visit-billing-review');};
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,setTimeout:()=>0,clearTimeout(){},
 me:{role:'owner'},activeVisit:{id:'visit',status:'signed'},$:node,esc,human:v=>String(v),date:v=>v,money:v=>String(v),
 document:{addEventListener:(n,f)=>{if(n==='click')handlers.push(f);},createElement:()=>({setAttribute(){}})},
 // The tab switch the Note/Billing/History tabs use: it sets the attribute the stylesheet reads.
 invoiceTabSet(key){node('encounter-revenue').dataset.invoiceTab=key;rebuild();},
 encounterRevenueState:{data:{summary:visitSummary()},review:null}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/visit-review.js','utf8'),ctx);

// The panel's own markup is not under test here; the stubs give it content to find.
ctx.visitBillingStateContext=()=>({});ctx.visitReviewPanelMarkup=()=>'<h2>Check the claim</h2>';
const css=fs.readFileSync('web/visit-billing.css','utf8');
const rules=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m=>({sel:m[1].trim(),body:m[2]}));
const hiders=rules.filter(r=>/display:\s*none/.test(r.body)&&/#encounter-revenue\b/.test(r.sel));
// Every rule that blanket-hides the children of the Billing tab in any part must spare the panel.
const blanket=hiders.filter(r=>/data-invoice-tab="billing"\]/.test(r.sel)&&/>\s*(:not\([^)]*\)\s*)+$/.test(r.sel.split(',').pop().trim()));
assert.ok(blanket.some(r=>/data-billing-part="summary"/.test(r.sel)),'the summary rule is still there');
for(const r of blanket)assert.match(r.sel,/:not\(#visit-billing-review\)/,`rule spares the review panel: ${r.sel.slice(0,80)}`);
for(const r of hiders)assert.ok(!/#visit-billing-review/.test(r.sel.replace(/:not\(#visit-billing-review\)/g,'')),`no rule hides the panel by name: ${r.sel.slice(0,80)}`);

const open=(tab,part)=>{
 const page=node('encounter-revenue');page.dataset.invoiceTab=tab;page.dataset.billingPart=part;
 node('visit-billing-review').hidden=true;
 vm.runInContext('visitReviewOpen',ctx)();
 const panel=ctx.$('visit-billing-review');
 assert.ok(panel.innerHTML.length>0,'the live panel has content');
 assert.equal(panel.hidden,false,`panel shown from ${tab}/${part}`);
 assert.equal(page.dataset.invoiceTab,'billing',`Billing tab active from ${tab}`);
 assert.equal(page.dataset.billingPart,part,'the billing part is left alone');
 assert.ok(panel.scrolled>=1,'scrolled to');
};
open('billing','summary');open('note','summary');open('history','summary');open('billing','claim');
// A later rebuild of the Billing area keeps an open panel open, and a closed one closed.
open('note','summary');
rebuild();vm.runInContext('visitReviewRestore',ctx)();
assert.equal(ctx.$('visit-billing-review').hidden,false,'still open after a rebuild');
assert.ok(ctx.$('visit-billing-review').innerHTML.length>0);
// Close hides the panel again and leaves the Billing tab as it was.
ctx.visitReviewClose?.();vm.runInContext('visitReviewClose',ctx)();
assert.equal(node('visit-billing-review').hidden,true);
assert.equal(node('encounter-revenue').dataset.invoiceTab,'billing');
rebuild();vm.runInContext('visitReviewRestore',ctx)();
assert.equal(ctx.$('visit-billing-review').hidden,true,'closed stays closed after a rebuild');
console.log('visit review open-visible checks ok');
