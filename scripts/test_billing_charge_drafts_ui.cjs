// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const handlers={},nodes={},account={id:'account',status:'draft',version:3,content:{visit_id:'visit'}};
const makeForm=(snapshot='edited')=>({dataset:{patient:'patient',draftKey:'patient:account:account',id:'account',version:'2'},elements:{visit_id:{value:'visit'}},snapshot,submit:{disabled:false},querySelector(){return this.submit;},querySelectorAll(){return [];},insertAdjacentHTML(_,html){this.notice=html;},remove(){delete nodes['billing-account-form'];}});
const ctx={console,me:{role:'owner'},selected:'patient',chartSection:'visits',workspace:{billing:{accounts:[account]}},activeVisit:{id:'visit'},document:{addEventListener:(name,handler)=>(handlers[name]??=[]).push(handler)},$:id=>nodes[id],esc:String,notice(){},run:fn=>ctx.pending=fn(),confirmAction:async()=>true};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);
// State/version tests use a snapshot sentinel; browser validation covers actual DOM cloning.
ctx.billingChargeMarkup=form=>form.snapshot;
const evaluate=code=>vm.runInContext(code,ctx);
ctx.clearBillingChargeDrafts();nodes['billing-account-form']=makeForm();ctx.form=nodes['billing-account-form'];evaluate("billingChargeBaselines.set(form,'original')");
ctx.captureBillingChargeDraft();assert.equal(evaluate('billingChargeDrafts.size'),1);assert.equal(evaluate("billingChargeDrafts.get('patient:account:account').version"),2);
ctx.openBillingEditor=html=>{nodes['billing-account-form']=makeForm(html);};
assert.equal(ctx.restoreBillingChargeDraft(account,null,'visit'),true);assert.equal(nodes['billing-account-form'].dataset.draftStale,'true');assert.equal(nodes['billing-account-form'].submit.disabled,true);assert.match(nodes['billing-account-form'].notice,/Saved charges changed/);
const button={dataset:{},hasAttribute:name=>name==='data-rebase-charge-draft',closest:()=>null};
for(const handler of handlers.click)handler({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});
assert.equal(nodes['billing-account-form'].dataset.version,'3');assert.equal(nodes['billing-account-form'].submit.disabled,false);assert.equal(nodes['billing-account-form'].dataset.draftStale,undefined);
let form=nodes['billing-account-form'];ctx.billingChargeSaved(form,{id:'account',version:4},'edited');ctx.captureBillingChargeDraft();assert.equal(evaluate('billingChargeDrafts.size'),0,'successful unchanged save must not recreate a draft during reload');
form.snapshot='typed during save';ctx.billingChargeSaved(form,{id:'account',version:5},'edited');assert.equal(evaluate('billingChargeDrafts.size'),1);assert.equal(evaluate("billingChargeDrafts.get('patient:account:account').version"),5);assert.equal(evaluate("billingChargeDrafts.get('patient:account:account').html"),'typed during save');
ctx.selected='another-patient';assert.ok(!ctx.billingChargeDraftFor('account',null,'visit'));ctx.selected='patient';
account.status='posted';assert.equal(ctx.restoreBillingChargeDraft(account,null,'visit'),true);assert.equal(nodes['billing-account-form'].dataset.draftReadOnly,'true');assert.match(nodes['billing-account-form'].notice,/not part of the current saved account/);
ctx.me={role:'owner'};assert.equal(ctx.billingChargeHasDrafts(),false,'staff-session change must clear retained charge contents');
console.log('PASS charge draft patient/staff isolation, stale-version review, posted-account recovery, unchanged-save clearing and typing-during-save preservation');
