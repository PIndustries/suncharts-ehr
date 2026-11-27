// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const claims=fs.readFileSync('web/claims.js','utf8');
const c=vm.createContext({document:{addEventListener(){}},money:n=>'$'+n/100,esc:String,displayStatus:String,displayDate:String});
vm.runInContext(claims,c);c.encounterRowChip=()=>'<a href="#synthetic-encounter">ENC-0004</a>';
for(const [row,group] of [[{status:'draft'},'send'],[{status:'ready'},'send'],[{status:'rejected'},'fix'],[{status:'accepted',claimmd_position:{needs_correction:true}},'fix'],[{status:'accepted'},'wait'],[{status:'submitted'},'wait'],[{status:'adjudicated'},''],[{status:'void'},''],[{status:'accepted',crossover_tracking_only:true},'']])assert.equal(c.claimWorkGroup(row),group);
for(const status of ['draft','ready']){
 for(const outcome of ['queued','waiting','delivered','recorded_externally']){
  assert.equal(c.claimWorkGroup({status,claim_handoff:{outcome}}),'wait',status+' '+outcome);
 }
 assert.equal(c.claimWorkGroup({status,claim_handoff:{outcome:'blocked'}}),'fix',status+' blocked');
 assert.equal(c.claimWorkGroup({status,claim_handoff:{outcome:'prepared'}}),'send',status+' prepared');
}
c.claimRows=[{id:'later',service_date:'2026-11-12',patient_name:'Synthetic',status:'draft',total_cents:100},{id:'earlier',service_date:'2026-11-01',patient_name:'Synthetic',status:'draft',total_cents:100,control_number:'SYN-100',visit_id:'synthetic-visit'}];
const rows=c.claimRowsMarkup(c.claimRows);assert(rows.indexOf('earlier')<rows.indexOf('later'));assert(rows.includes('Claim SYN-100'));assert.match(rows,/claim-status-send/);assert.match(rows,/#synthetic-encounter/);
for(const [status,tone] of [['draft','send'],['rejected','fix'],['submitted','wait']])assert.match(c.claimRowMarkup({status}),new RegExp('claim-status-'+tone));const posted={status:'adjudicated',remittance_posted:true,paid_cents:25000};
assert.match(c.claimRowMarkup(posted),/claim-status-paid/);
assert.doesNotMatch(c.claimRowMarkup({...posted,payer_denied:true}),/claim-status-paid/);
assert.doesNotMatch(c.claimRowMarkup({...posted,paid_cents:0}),/claim-status-paid/);
for(const [key,line]of [['send','No claims to send.'],['fix','No claims need correction.'],['wait','No claims waiting for a response.']]){c.claimStatusFilter=key;assert(c.claimEmptyRow().includes(line));}
assert.match(claims,/management&&!claimMdConnectionState\?\.connected\)management\.insertAdjacentHTML\('beforebegin',claimMdConnectionCard\(\)\)/);
const css=fs.readFileSync('web/frame.css','utf8');assert.match(css,/height:100dvh;overflow:hidden/);assert.match(css,/#tools\{min-height:0;overflow:auto;flex:1\}/);
console.log('PASS Billing groups, correction precedence, oldest first, private identifiers, empty states, connection banner and contained scrolling');
