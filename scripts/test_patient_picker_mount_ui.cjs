// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The patient box on a form is connected to its search by mountPatientPicker. The booking form
// carries an attribute with the same name as the box's own (the patient to start with), and taking
// the form for the box left the box unconnected: typing opened no list. The box is found from its
// input, whatever the form around it carries.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const ctx={console,Map,Set,Date,Promise,setTimeout:()=>0,clearTimeout(){},document:{addEventListener(){}},esc:value=>String(value??'')};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','web','patient-picker.js'),'utf8'),ctx);
const markup=vm.runInContext("patientPickerMarkup({label:'Patient',name:'patient_id'})",ctx);
const id=/data-patient-picker="([^"]+)"/.exec(markup)[1];
const part=name=>({name,querySelector:()=>null});
const input={...part('input')},field=part('field'),list=part('list'),status=part('status');
const popup={querySelector:selector=>selector.includes('list')?list:selector.includes('status')?status:null};
const box={dataset:{patientPicker:id},querySelector:selector=>selector==='[data-patient-picker-input]'?input:selector==='[data-patient-picker-field]'?field:selector==='[data-patient-picker-popup]'?popup:null};
input.closest=selector=>selector==='[data-patient-picker]'?box:null;
// The form answers to the same attribute, with a patient id (or nothing) in it, and is its own closest match.
const form={dataset:{patientPicker:''},querySelector:selector=>selector==='[data-patient-picker-input]'?input:selector==='[data-patient-picker]'?box:null};
form.closest=selector=>selector==='[data-patient-picker]'?form:null;
ctx.form=form;
const picker=vm.runInContext('mountPatientPicker(form)',ctx);
assert.ok(picker,'the box is connected even though the form carries the same attribute');
assert.equal(picker.input,input,'typing reaches the search');assert.equal(picker.popup,popup);assert.equal(picker.list,list);
assert.equal(box.dataset.patientPickerMounted,'1');assert.equal(form.dataset.patientPickerMounted,undefined,'the form is not mistaken for the box');
console.log('PASS patient picker: a form carrying the same attribute does not leave the patient box unconnected');
