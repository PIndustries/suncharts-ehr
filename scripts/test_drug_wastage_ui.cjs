// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Drug wastage: staff type the units given and the vial size, and the helper works out how many
// vials were opened and how much was discarded. Nothing discarded means JZ on the line; anything
// discarded means a second line with JW. The vial size last used for a drug comes back by itself.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('web/fees.js','utf8');
const part=src.slice(src.indexOf("const drugVialStore="),src.indexOf('function drugWasteModifiers('));
const store={};
const ctx={localStorage:{getItem:k=>store[k]??null,setItem:(k,v)=>{store[k]=v;}},Math,Number,String};
vm.createContext(ctx);vm.runInContext(part,ctx);
function row(given,vial,code='J0585'){
 const fields={'[data-waste-given]':{value:given},'[data-waste-vial]':{value:vial},'[name="code"]':{value:code},'[data-drug-waste-note]':{textContent:''}};
 const box={querySelector:s=>fields[s]||null};
 return {fields,querySelector:s=>s==='[data-drug-waste]'?box:fields[s]||null};
}
assert.deepEqual({...ctx.drugWasteFacts(row('155','100'))},{given:155,vial:100,vials:2,discarded:45,ready:true});
assert.deepEqual({...ctx.drugWasteFacts(row('200','100'))},{given:200,vial:100,vials:2,discarded:0,ready:true});
assert.equal(ctx.drugWasteFacts(row('','100')).ready,false);
assert.equal(ctx.drugWasteFacts(row('50','')).ready,false,'no vial size and none remembered');
store['suncharts.drugVialSize.J0585']='100';
const remembered=row('50','');
assert.deepEqual({...ctx.drugWasteFacts(remembered)},{given:50,vial:100,vials:1,discarded:50,ready:true});
assert.equal(remembered.fields['[data-waste-vial]'].value,'100','the remembered vial size is shown in the box');
const wasted=row('155','100');ctx.drugWasteNote(wasted);
assert.match(wasted.fields['[data-drug-waste-note]'].textContent,/2 vials opened: 155 given, 45 discarded.*JW line is added for 45/);
const none=row('100','100');ctx.drugWasteNote(none);
assert.match(none.fields['[data-drug-waste-note]'].textContent,/nothing discarded.*100 units with JZ/);
const markup=fs.readFileSync('web/billing.js','utf8');
assert.match(markup,/data-drug-waste-apply>Set units and wastage</);
console.log('PASS drug wastage: vials and discarded amount are worked out, JZ or a JW line is announced, vial size is remembered');
