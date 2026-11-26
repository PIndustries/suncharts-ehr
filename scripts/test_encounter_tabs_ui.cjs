// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Legacy destinations open the steps and never set tab attributes or store a selected tab.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/patient-revenue.js','utf8'),nodes={'encounter-revenue':{dataset:{invoiceTab:'note'}},'visit-page-host':{dataset:{encounterTab:'note'}}},calls=[];
const ctx={$:id=>nodes[id],encounterStepOpen:step=>calls.push(step),encounterHistoryOpen:()=>calls.push('history'),encounterStepsSchedule:()=>{},encounterChargeTableInline:()=>{}};
vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function invoiceTabsMarkup()'),source.indexOf('// The claim made from these codes',source.indexOf('function invoiceTabsMarkup()'))),ctx);
assert.equal(ctx.invoiceTabsMarkup(),'');
for(const [key,step] of [['note',1],['billing','claim'],['payments',2]]){ctx.invoiceTabSet(key);assert.equal(calls.pop(),step);}
ctx.invoiceTabSet('billing',false);assert.deepEqual(calls,[],'refreshing the view does not move the reader');
ctx.invoiceTabSet('history');assert.equal(calls.pop(),'history');
assert.equal(nodes['visit-page-host'].dataset.encounterTab,undefined);assert.equal(nodes['encounter-revenue'].dataset.invoiceTab,undefined);
console.log('PASS old tab destinations open encounter steps; History opens its sheet; no tab markup or stored tab');
