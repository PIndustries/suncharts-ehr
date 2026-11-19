// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The Partners screen: payments step states, the recommended partner first with its Enroll card,
// the plain consent form, the enrolled line with Leave, and the not-connected card. Synthetic only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/partners.js','utf8');
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const context=vm.createContext({Map,Set,WeakMap,Object,Array,Number,String,Date,JSON,Intl,Error,Promise,console,esc,me:{role:'owner'},
 crypto:{randomUUID:()=>'00000000-0000-4000-8000-000000000001'},document:{addEventListener(){}},window:{},api:async()=>({}),setTimeout,clearTimeout});
vm.runInContext(source,context);
const run=js=>vm.runInContext(js,context);
const ht={slug:'healthtech',name:'HealthTech',summary:'Billing, claims and payments for your practice.',services:['Insurance billing','Claims and denials'],preferred:true,enrolled:false};
// Step 1: payments.
assert.match(context.partnersPaymentStep({state:'ready'}),/Payments set up/);
assert.match(context.partnersPaymentStep({state:'none'}),/Set up payments/);
assert.match(context.partnersPaymentStep({state:'unavailable'}),/Connect this EHR to SunCharts/);
// Step 2: the recommended partner, its services and an Enroll button.
const card=context.partnerCard(ht);
assert.match(card,/HealthTech/);assert.match(card,/Recommended/);assert.match(card,/Insurance billing/);assert.match(card,/Enroll/);
assert.match(context.partnerCard({...ht,enrolled:true}),/Current partner/);
// The consent form: what the partner gets, one required box, one button.
const confirm=context.partnerEnrollConfirm(ht);
assert.match(confirm,/HealthTech will be able to see your claims and payments, work your support tickets, and sign in to help when you allow it\./);
assert.match(confirm,/name="agree" required/);assert.match(confirm,/I agree to share this practice with HealthTech/);assert.match(confirm,/Enroll with HealthTech/);
// Enrolled: the date, the notice, and Leave.
const done=context.partnersEnrollment({status:'active',partner_name:'HealthTech',enrolled_at:'2026-11-19T15:00:00Z'});
assert.match(done,/Enrolled with HealthTech on /);assert.match(done,/They have been notified\./);assert.match(done,/Leave HealthTech/);
assert.equal(context.partnersEnrollment({status:'ended',partner_name:'HealthTech'}),'');
// Not connected to SunCharts: the connect card instead of a list.
const notPaired=context.partnersBillingSection({partners:{connect_error:'Connect this EHR to SunCharts first.'},onboarding:{}});
assert.doesNotMatch(notPaired,/Enroll/);
const listed=context.partnersBillingSection({partners:{items:[ht],enrollment:null}});
assert.match(listed,/data-partner|Enroll/);
// Theme: the screen uses theme tokens, never a fixed colour.
assert.doesNotMatch(source,/#[0-9a-fA-F]{3,6}\b/,'no hard-coded colours in the Partners screen');
console.log('PASS Partners screen: payment step states, recommended partner card, consent form, enrolled line with Leave, connect card, theme tokens');
