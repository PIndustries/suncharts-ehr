// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The Work queue lists what is waiting on the practice, gathered from where each kind of work lives:
// open notes, encounters whose billing waits on staff, unreviewed results and overdue referrals. Work
// that waits on an insurer or a patient is not staff work and is left out. Synthetic rows only.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const names={post_charges:'Post charges',fix_claim:'Claim needs details',waiting_insurer:'Waiting on insurer',patient_owes:'Patient owes',denied:'Denied: fix and resend'};
const queueClicks=[];
const ctx={console,URLSearchParams,Promise,Set,Number,String,Array,Object,JSON,setTimeout:()=>0,clearTimeout(){},document:{addEventListener(event,handler){if(event==='click')queueClicks.push(handler);}},
 esc:value=>String(value??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),money:cents=>'$'+(cents/100).toFixed(2),displayDate:value=>'on '+value,visitBillingStateName:state=>names[state]||state};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'..','web','checkout.js'),'utf8'),ctx);
// Rows are copied out of the vm so they compare as this realm's own arrays and objects.
const queueItems=vm.runInContext('workQueueItems',ctx),items=src=>JSON.parse(JSON.stringify(queueItems(src))),markup=vm.runInContext('workQueueMarkup',ctx);
const src={
 unfinished:{items:[{visit_id:'v1',patient_id:'p1',patient_name:'Synthetic, Avery',mrn:'SYN-1',title:'Follow-up visit',starts_at:'2026-11-20T11:00:00Z',provider_label:'Dr Example',note_saved:false},{visit_id:'v2',patient_id:'p2',patient_name:'Synthetic, Blake',mrn:'SYN-2',title:'Office visit',starts_at:'2026-11-19T09:00:00Z',note_saved:true}]},
 accounts:{items:[
  {id:'a1',patient_id:'p1',patient_name:'Synthetic, Avery',mrn:'SYN-1',billing_state:'post_charges',service_date:'2026-11-20',total_cents:53000,payer_name:null},
  {id:'a2',patient_id:'p1',patient_name:'Synthetic, Avery',mrn:'SYN-1',billing_state:'fix_claim',service_date:'2026-11-20',total_cents:83000,payer_name:'Synthetic plan'},
  {id:'a3',patient_id:'p2',patient_name:'Synthetic, Blake',mrn:'SYN-2',billing_state:'waiting_insurer',service_date:'2026-11-18',total_cents:1000,payer_name:'Synthetic plan'},
  {id:'a4',patient_id:'p2',patient_name:'Synthetic, Blake',mrn:'SYN-2',billing_state:'patient_owes',service_date:'2026-11-18',total_cents:1000}]},
 claims:{items:[
  {account_id:'a2',patient_id:'p1',patient_name:'Synthetic, Avery',status:'draft',payer_name:'Synthetic plan',total_cents:83000,claimmd_position:{needs_correction:false}},
  {account_id:'a9',patient_id:'p3',patient_name:'Synthetic, Casey',status:'ready',payer_name:'Synthetic plan',total_cents:135000,claimmd_position:{needs_correction:false}},
  {account_id:'a8',patient_id:'p3',patient_name:'Synthetic, Casey',status:'submitted',payer_name:'Synthetic plan',total_cents:500,claimmd_position:{needs_correction:true}},
  {account_id:'a7',patient_id:'p3',patient_name:'Synthetic, Casey',status:'submitted',payer_name:'Synthetic plan',total_cents:500,claimmd_position:{needs_correction:false}}]},
 results:{items:[{patient_id:'p1',patient_name:'Synthetic, Avery',mrn:'SYN-1',order_id:'o1',title:'Synthetic panel',critical:true}]},
 referrals:{items:[
  {id:'r1',patient_id:'p2',patient_label:'Synthetic, Blake',mrn:'SYN-2',content:{requested_service:'Synthetic consult'}},
  {id:'r2',patient_id:'p2',patient_label:'Synthetic, Blake',mrn:'SYN-2',content:{requested_service:'Synthetic follow-up'}}]}
};
const rows=items(src),of=kind=>rows.filter(row=>row.kind===kind);
assert.deepEqual(of('notes').map(row=>row.what),['Write the encounter note','Finish and sign the note'],'an open note is named by what is left to do');
assert.match(of('notes')[0].attrs,/data-queue-visit="v1" data-patient="p1"/,'a note row opens its own encounter');
assert.deepEqual(of('billing').map(row=>row.what),['Post charges','Claim needs details','Send claim','Claim needs correcting'],'billing lists only what waits on staff, and a claim once');
assert.ok(!rows.some(row=>/Waiting on insurer|Patient owes/.test(row.what)),'work waiting on an insurer or a patient is not staff work');
assert.match(of('billing')[0].attrs,/data-queue-account="a1" data-patient="p1"/);assert.match(of('billing')[0].detail,/on 2026-11-20 · \$530\.00/);
assert.equal(of('billing')[3].urgent,true,'a claim to correct stands out');
assert.equal(of('results')[0].what,'Critical result to review');assert.equal(of('referrals')[0].detail,'Synthetic consult');
assert.match(of('referrals')[0].attrs,/data-referral-open-patient="p2" data-referral-id="r1"/);
assert.match(of('referrals')[1].attrs,/data-referral-open-patient="p2" data-referral-id="r2"/);
assert.match(of('referrals')[1].label,/^Open referral$/);
assert.equal(items({referrals:{items:[{patient_label:'Synthetic, Blake'}]}})[0].attrs,'data-queue-referrals','a row missing an identifier keeps the worklist fallback');
assert.deepEqual(items({}),[],'lists that did not load leave the queue empty, not broken');
const all=markup(rows,2,'all',false);
assert.match(all,/Everything <span class="pill">11<\/span>/,'the total counts every row and every open task');
assert.match(all,/Charges and claims <span class="pill">4<\/span>/);assert.match(all,/Tasks <span class="pill">2<\/span>/);
assert.equal((all.match(/<li/g)||[]).length,9);assert.match(all,/class="is-urgent"/);
const only=markup(rows,2,'notes',false);assert.equal((only.match(/<li/g)||[]).length,2,'a kind shows only its own rows');assert.match(only,/data-queue-kind="notes" aria-pressed="true"/);
assert.match(markup([],0,'all',false),/Nothing is waiting on the practice right now\./);assert.doesNotMatch(markup(rows,0,'all',false),/Nothing is waiting/);
assert.match(markup([],0,'all',true),/Some lists are not shown/);
assert.doesNotMatch(markup([],0,'all',true),/Nothing is waiting/);
const exactClaims=items({accounts:{items:[{id:'account',billing_state:'fix_claim'}]},claims:{items:[{id:'claim-a',account_id:'account',status:'rejected'},{id:'claim-b',account_id:'account',status:'ready'},{id:'crossover',account_id:'account',status:'ready',crossover_tracking_only:true}]}});
assert.deepEqual(exactClaims.map(r=>r.attrs),['data-queue-claim="claim-a"','data-queue-claim="claim-b"']);
const payerQueue=items({remittances:{items:['staged','reconciled','posted','reversed','rejected'].map(status=>({id:status,status,payer_name:'Synthetic payer',total_paid_cents:7300}))}});
assert.deepEqual(payerQueue.map(r=>[r.what,r.attrs]),[['Review insurance payment','data-queue-remittance="staged"'],['Review reconciled payment','data-queue-remittance="reconciled"']]);
assert.match(markup(payerQueue,0,'remittances',false,true),/Load more insurance payments/);
ctx.workspaceResourceAllowed=resource=>resource!=='claims';assert.doesNotMatch(markup([],0,'all',false),/data-queue-kind="remittances"/);delete ctx.workspaceResourceAllowed;
assert.doesNotMatch(markup(items({results:{items:[{patient_name:'<b>x</b>',mrn:'1',title:'"t"',patient_id:'p',order_id:'o'}]}}),0,'all',false),/<b>x<\/b>/,'names are escaped');
(async()=>{
 const first={id:'first',patient_id:'p1',visit_id:'v1',encounter_number:1,billing_state:'post_charges',total_cents:15000};
 const second={...first,id:'second',visit_id:'v2',encounter_number:2,total_cents:25000,invoice_id:'saved-statement'};
 ctx.me={role:'front_desk'};
 ctx.workspaceResourceAllowed=resource=>resource==='billing';
 ctx.encounterNumberLabel=number=>'ENC-'+number;
 ctx.encounterTimelineChip=()=>'<button data-encounter-chip>Open encounter</button>';
 ctx.sourceAccounts={items:[first,second]};
 vm.runInContext('workQueueIdentity=me;workQueueSources={accounts:sourceAccounts}',ctx);
 const restricted=markup(items({accounts:ctx.sourceAccounts}),0,'billing',false);
 assert.match(restricted,/data-queue-account="second" data-patient="p1">Review charge account/);
 assert.match(restricted,/ENC-2/);assert.match(restricted,/\$250\.00 gross charges/);
 assert.doesNotMatch(restricted,/data-encounter-chip|Open encounter|Review claim/);
 const preview={},seen=[];
 const scope={patientId:'p1',host:{querySelector:selector=>selector==='#patient-billing-preview'?preview:null},native:{accounts:{items:[first]}}};
 ctx.run=fn=>fn();
 ctx.frameSelectPatient=()=>assert.fail('billing-only must stay out of the clinical chart');
 ctx.showPatientBillingWorkspace=async options=>{seen.push([options.patientId,options.tab,options.mode]);return scope;};
 ctx.patientBillingCurrent=value=>value===scope;
 ctx.showBillingAccountReview=async(host,row,current)=>{assert.equal(host,preview);assert.equal(current(),true);seen.push([row.id,row.invoice_id]);};
 const click=(patient,account)=>queueClicks[0]({target:{closest:()=>({dataset:{patient,queueAccount:account},hasAttribute:()=>false})}});
 await click('p2','second');await click('p1','missing');await click('p1','second');
 assert.deepEqual(seen,[['p1','overview','recorded'],['second','saved-statement']]);
 ctx.workspaceResourceAllowed=()=>false;
 await click('p1','first');
 assert.equal(seen.length,2);
 console.log('PASS Work queue staff steps, counts, filters, escaping, and exact account review with billing-only access');
})().catch(error=>{console.error(error);process.exitCode=1;});
