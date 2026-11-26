// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/demographics.js','utf8'),css=fs.readFileSync('web/frame.css','utf8');
const c=vm.createContext({document:{addEventListener(){}},selected:'synthetic',me:{role:'owner'},esc:v=>String(v??'').replaceAll('<','&lt;'),date:v=>v,chartAreaEnabled:()=>true});
vm.runInContext(source,c);
const html=vm.runInContext(`demographicsSummary({content:{phone:'555-0100',email:'synthetic@example.test',address:{city:'Synthetic City'},emergency_contact:{name:'<Synthetic>'}},history:[]})`,c);
for(const title of ['Contact','Address','Emergency contact','Preferred pharmacy','Patient portal','Intake forms'])assert(html.includes('<h2>'+title+'</h2>'),title);
assert.doesNotMatch(html,/<form|<input|<select|<textarea/);
assert.match(html,/&lt;Synthetic>/);assert.match(html,/data-demographics-edit="address"/);assert.match(html,/data-demographics-edit="emergency"/);assert.match(html,/More ▾/);assert.match(html,/Send an intake form/);
c.me.role='billing_staff';assert.doesNotMatch(vm.runInContext('demographicsSummary({content:{},history:[]})',c),/data-demographics-edit|data-portal-access/);
assert.match(css,/@media\(min-width:1000px\)\{#patient-demographics \.profile-cards\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
assert.match(source,/sheetOpen\('Edit '\+part,editor\)/);
assert.match(source,/profile\.version/);assert.match(source,/sameChart/);
console.log('PASS Profile read-only cards, editor routes, escaped values, permissions and responsive columns');
