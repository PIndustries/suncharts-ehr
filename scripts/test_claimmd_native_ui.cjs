// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const native=fs.readFileSync('web/claimmd-native.js','utf8');
const billing=fs.readFileSync('web/billing.js','utf8');
const claims=fs.readFileSync('web/claims.js','utf8');
const index=fs.readFileSync('web/index.html','utf8');
assert.match(index,/claimmd-native\.js/);
assert.match(native,/\/api\/v1\/billing\/claimmd\/status/);
assert.doesNotMatch(native,/Native integration/);
assert.match(native,/Eligibility checks, claims, payer responses and insurance payments go through this account/);
assert.match(native,/INSURANCE CLAIMS/);
for(const stage of ['Check insurance','Prepare claims','Send and track','Insurance payments'])assert.match(native,new RegExp(stage.replace('&','&')));
assert.match(native,/data-claimmd-journey/);
assert.doesNotMatch(native,/account_key|encrypted_key|credential_fingerprint/,'staff connection card must not expose secret fields');
assert.match(billing,/loadClaimMdConnection\(\)/);
assert.match(billing,/claimMdConnectionCard\(\)/);
assert.match(billing,/Patient coverage, charges and connected revenue-cycle workflows/);
assert.match(claims,/loadClaimMdConnection\(\)/);
assert.match(claims,/claimMdConnectionCard\(\)/);
assert.match(claims,/Send claims, see payer responses and post insurance payments/);
console.log('PASS Claim.MD is presented as a native revenue-cycle connection');

const vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const context=vm.createContext({document:{addEventListener(){}},esc:value=>String(value??'').replaceAll('<','&lt;'),human:String,date:String});
vm.runInContext(native,context);
const claim={status:'adjudicated',snapshot:{account:{coverage_snapshot:{coverage:{id:'synthetic'}}}}};
const stage=(html,label)=>html.match(new RegExp('<li class="([^"]+)"[^]*?<b>'+label+'</b>'));
let html=context.claimMdClaimLifecycle(claim,{}, {items:[{reason:'submission acceptance received'}]});
assert.match(html,/Eligibility is checked separately/);
assert.match(html,/Eligibility has not been checked/);
assert.match(html,/No insurance payment posted yet/);
assert.doesNotMatch(html,/From coverage to settled balance/);
assert.match(html,/<li class="(?:is-upcoming|is-current)"><span>4<\/span><div><b>Sent to clearinghouse/,'free text and adjudication do not prove delivery');
assert.match(html,/<li class="is-upcoming"><span>2<\/span><div><b>Eligibility checked/,'coverage alone does not complete eligibility');
html=context.claimMdClaimLifecycle(claim,{tracking:{eligibility:{status:'completed',service_date:'2026-11-10'},submissions:[{status:'delivered'}],reports:[{received_at:'2026-11-10',evidence:{senderid:'CLMMD',status:'A',message:{message:'Acknowledged <unsafe>',status:'A'}}}],connections:[{paused:false,last_poll_at:'2026-11-10',last_success_at:'2026-11-09',last_result:'poll_failed_cursor_retained'}]}});
assert.match(html,/Claim.MD clearinghouse/);assert.match(html,/Acknowledged &lt;unsafe>/);assert.match(html,/Last checked/);assert.match(html,/poll_failed_cursor_retained/);
assert.match(html,/The payer still has to accept it/);assert.match(html,/No insurance payment posted yet/);
assert.doesNotMatch(html,/Current payer state: Adjudicated/);
html=context.claimMdClaimLifecycle({status:'ready',snapshot:claim.snapshot},{tracking:{submissions:[{status:'delivered'}],reports:[]}});
assert.match(html,/<li class="is-current"><span>5<\/span><div><b>Payer response/,'delivery advances the displayed stage without assuming eligibility completed');
assert.doesNotMatch(html,/<p>Send this claim to Claim.MD.<\/p>/,'do not prompt duplicate submission after a recorded delivery');
html=context.claimMdTrackingSummary({reports:[{evidence:{senderid:'SYN-PAYER',sender_name:'Synthetic Payer',message:{message:'Finalized/Payment'}},received_at:'2026-11-10'}]});
assert.match(html,/From the payer or another sender \(check the sender below\)/);assert.match(html,/do not post insurance payments/);
console.log('PASS coverage, transport, response sender and remittance milestones require distinct recorded evidence');
