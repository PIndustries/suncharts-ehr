// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const fields={},notices=[];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const account={id:'account',patient_id:'patient',version:5};
const record={id:'claim',version:1};
const ctx={console,document:{addEventListener(){}},esc,me:'clinician',notices,FormData:class{constructor(form){return Object.entries(form.values||{})[Symbol.iterator]();}},notice:()=>{}};
ctx.notices=notices;vm.createContext(ctx);
vm.runInContext(`
 function fakeField(name,type,value,checked){const field={name,type,value:typeof value==='string'?value:'',checked:!!checked};field.setAttribute=()=>{};return field;}
 function makeForm(built){const elements=Object.entries(built).map(([name,spec])=>fakeField(name,spec.type||'text',spec.value,spec.checked));const form={elements,dataset:{},values:Object.fromEntries(elements.map(f=>[f.name,f.type==='checkbox'?(f.checked?'on':''):f.value])),insertAdjacentHTML(_,html){notices.push(html);}};form.claimMdDetail={id:'detail',version:1};return form;}
 function draftSet(form,values,request){claimDrafts.set(form.claimDraftKey,{values,version:1,request});}
 function draftGet(){return claimDrafts.get(claimDraftKey({id:'account',patient_id:'patient'},{id:'claim',version:1},'packet'));}
`,ctx);
vm.runInContext(fs.readFileSync('web/claims.js','utf8'),ctx);
const makeForm=ctx.makeForm,makeAccount={...account};

// 1. An empty draft value must not wipe a field the freshly built form prefilled; a typed value still wins.
let form=makeForm({billing_line1:{value:'15 Test Street'},reason:{value:''}});
ctx.restoreClaimDraft(form,makeAccount,record);
ctx.draftSet(form,{billing_line1:'',reason:'typed'},'req-1');
ctx.restoreClaimDraft(form,makeAccount,record);
assert.equal(form.elements[0].value,'15 Test Street','prefilled billing_line1 must survive an empty draft value');
assert.equal(form.elements[1].value,'typed','a non-empty draft value must still be restored');
assert.equal(form.dataset.request,'req-1');
assert.equal(notices.length,1);assert.match(notices[0],/Your unsaved edits were restored\./);
assert.ok(ctx.draftGet(),'the draft stays while it still holds an edit');

// 2. A non-empty draft value beats a fresh prefill.
form=makeForm({billing_line1:{value:'15 Test Street'}});
ctx.restoreClaimDraft(form,makeAccount,record);
ctx.draftSet(form,{billing_line1:'My Street'},'req-2');
ctx.restoreClaimDraft(form,makeAccount,record);
assert.equal(form.elements[0].value,'My Street','a non-empty draft value wins over the built value');
assert.match(notices.at(-1),/Your unsaved edits were restored\./);

// 3. A draft whose only saved values are now-prefilled empties restores nothing: no notice, draft deleted.
ctx.clearClaimDrafts();
form=makeForm({billing_line1:{value:'15 Test Street'},billing_city:{value:'Austin'}});
ctx.restoreClaimDraft(form,makeAccount,record);
ctx.draftSet(form,{billing_line1:'',billing_city:''},'req-3');
const before=notices.length;
ctx.restoreClaimDraft(form,makeAccount,record);
assert.equal(form.elements[0].value,'15 Test Street');assert.equal(form.elements[1].value,'Austin');
assert.equal(notices.length,before,'nothing was different from the built form, so no notice');
assert.equal(ctx.draftGet(),undefined,'the no-op draft is dropped');

// 4. A checkbox restored as checked counts as a real restore, even with no other difference.
ctx.clearClaimDrafts();
form=makeForm({synthetic_test:{type:'checkbox',checked:false},reason:{value:''}});
ctx.restoreClaimDraft(form,makeAccount,record);
ctx.draftSet(form,{synthetic_test:'on'},'req-4');
ctx.restoreClaimDraft(form,makeAccount,record);
assert.equal(form.elements[0].checked,true,'a checked checkbox in the draft is restored');
assert.match(notices.at(-1),/Your unsaved edits were restored\./);
assert.ok(ctx.draftGet(),'the draft stays while its checked box still differs');

console.log('PASS claim draft restore keeps fresh prefill over empty saved values, drops no-op drafts and restores checked boxes');
