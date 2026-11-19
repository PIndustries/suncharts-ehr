// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The claim page's "Before this can be sent" list: every problem the server reports is listed,
// under the place it is fixed, and nothing is dropped.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'..','web','claims.js'),'utf8');
const start=source.indexOf('// Whether a rule names this problem'),end=source.indexOf('function claimMissingFocusFields');
assert.ok(start>0&&end>start,'the grouping code is where this test expects it');
const context={};vm.createContext(context);
vm.runInContext(source.slice(start,end)+';this.claimMissingGroupsFor=claimMissingGroupsFor;',context);
const issues=[
 'Tax ID is required',
 'Patient address is required',
 'Subscriber address is required',
 'Payer name can only use plain letters, numbers and basic punctuation (no long dashes, accents or curly quotes), up to 60 characters',
 'Insurer name can only use plain letters, numbers and basic punctuation (no long dashes, accents or curly quotes), 1 to 60 characters',
 'Tax ID must contain nine digits',
 'Subscriber date of birth is required',
 'Something the page has no rule for yet'
];
const b=context.claimMissingGroupsFor(issues);
assert.deepEqual([...b.practice.words],['Practice tax ID (9 digits)']);
assert.deepEqual([...b.patient.words],['Patient address']);
assert.deepEqual([...b.insurance.words],["Policy holder's address",'Insurance company name',"Policy holder's date of birth"]);
assert.deepEqual([...b.claim.words],['Something the page has no rule for yet'],'a problem no rule names is still listed');
assert.ok(!b.practice.words.includes('Billing provider name'),'a problem is never listed as something else');
const none=context.claimMissingGroupsFor([]);
assert.equal(Object.values(none).reduce((n,x)=>n+x.words.length,0),0);
console.log('PASS claim missing groups: every problem listed where it is fixed, none dropped');
