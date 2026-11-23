// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One timeline for an encounter: the steps come from the billing summary's own state so the header,
// the encounter page and the lists never disagree with the next-step bar. Exactly one step is "now"
// unless everything is done; self-pay has no claim or insurer step; a plan with no copay has no copay step.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ctx={esc,money:c=>'$'+(Number(c)/100).toFixed(2),visitBillingDate:v=>`date(${v})`,displayTime:v=>`time(${v})`,displayDate:v=>`day(${v})`,encounterNumberText:v=>v?`ENC-${String(v.encounter_number).padStart(4,'0')}`:'',Number,Date};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/encounter-timeline.js','utf8'),ctx);
const steps=(s,v=signed,a=appt)=>JSON.parse(JSON.stringify(ctx.encounterTimelineSteps(s,v,a)));
const signed={id:'v1',status:'signed',signed_at:'2030-01-02T09:40:00Z',encounter_number:2},open={id:'v1',status:'in_progress',encounter_number:2},appt={id:'a1',status:'in_progress',title:'Follow-up',starts_at:'2030-01-02T09:00:00Z'};
const insured=(over={})=>({state:'post_charges',account:{status:'draft'},charges_cents:12000,balance_cents:12000,insurance:{insured:true,insurer:'Synthetic Health',status:'not_billed',paid_cents:0,pending_cents:0},patient:{copay_cents:2500,copay_due_cents:0,copay_paid_cents:2500,owes_now_cents:0},receipts:[],...over});
const selfPay=(over={})=>({state:'post_charges',account:{status:'draft'},charges_cents:28000,balance_cents:28000,insurance:{insured:false},patient:{copay_cents:null,owes_now_cents:0},receipts:[],...over});
const nowOf=list=>{const now=list.filter(step=>step.state==='now');assert.equal(now.length,1,'exactly one step is now: '+JSON.stringify(list.map(x=>x.key+':'+x.state)));return now[0].key;};
// Each server state names the step staff act on.
const posted={account:{status:'posted'}};
const cases=[
 ['sign_visit',insured({state:'sign_visit'}),open,'note'],
 ['add_charges, note unsigned',insured({state:'add_charges',charges_cents:null}),open,'note'],
 ['add_charges, note signed',insured({state:'add_charges',charges_cents:null}),signed,'charges'],
 ['post_charges',insured(),signed,'charges'],
 ['prepare_claim',insured({...posted,state:'prepare_claim'}),signed,'claim'],
 ['fix_claim',insured({...posted,state:'fix_claim'}),signed,'claim'],
 ['send_claim',insured({...posted,state:'send_claim'}),signed,'claim'],
 ['denied',insured({...posted,state:'denied',insurance:{insured:true,status:'denied',pending_cents:12000,paid_cents:0}}),signed,'claim'],
 ['waiting_insurer',insured({...posted,state:'waiting_insurer',insurance:{insured:true,status:'waiting',sent_on:'2030-01-03',pending_cents:12000,paid_cents:0}}),signed,'insurer'],
 ['post_response',insured({...posted,state:'post_response',insurance:{insured:true,status:'answered',pending_cents:0,paid_cents:9000}}),signed,'insurer'],
 ['patient_owes',insured({...posted,state:'patient_owes',insurance:{insured:true,status:'answered',pending_cents:0,paid_cents:9000},patient:{copay_cents:2500,copay_due_cents:0,copay_paid_cents:2500,owes_now_cents:3000}}),signed,'closed'],
 ['self_pay_collect',selfPay({...posted,state:'self_pay_collect',patient:{copay_cents:null,owes_now_cents:28000}}),signed,'closed'],
 ['self-pay post_charges',selfPay(),signed,'charges'],
];
for(const [name,summary,visit,key] of cases){assert.equal(nowOf(steps(summary,visit)),key,name);}
// The wording of the step in hand.
const detail=(summary,key,visit=signed)=>steps(summary,visit).find(step=>step.key===key).detail;
assert.equal(detail(cases[5][1],'claim'),'Needs fixing');
assert.equal(detail(cases[7][1],'claim'),'Needs fixing');
assert.equal(detail(cases[10][1],'closed'),'Patient owes $30.00');
assert.equal(detail(cases[11][1],'closed'),'Patient owes $280.00');
assert.equal(detail(cases[8][1],'insurer'),'$120.00 pending');
// Self-pay: no claim or insurer step. A plan with no copay: no copay step. A plan with one: it is there.
assert.deepEqual(steps(selfPay()).map(s=>s.key),['checkin','note','charges','closed']);
assert.ok(!steps(insured()).every(s=>s.key!=='copay'));
assert.deepEqual(steps(insured({patient:{copay_cents:null,owes_now_cents:0}})).map(s=>s.key),['checkin','note','charges','claim','insurer','closed']);
assert.equal(detail(insured(),'copay'),'$25.00 paid');
assert.equal(detail(insured({patient:{copay_cents:2500,copay_due_cents:2500,copay_paid_cents:0,owes_now_cents:0}}),'copay'),'$25.00 due');
// Steps passed over are skipped, steps after the current one are later.
{const list=steps(insured({state:'post_charges',patient:{copay_cents:2500,copay_due_cents:2500,copay_paid_cents:0}}),signed);
 assert.equal(list.find(s=>s.key==='copay').state,'skipped');assert.equal(list.find(s=>s.key==='claim').state,'later');assert.equal(list.find(s=>s.key==='note').state,'done');}
// Everything done: the last step is done, nothing is now, the chip says Closed.
const finished=insured({...posted,state:'paid_in_full',balance_cents:0,insurance:{insured:true,status:'answered',sent_on:'2030-01-03',pending_cents:0,paid_cents:9500},patient:{copay_cents:2500,copay_due_cents:0,copay_paid_cents:2500,owes_now_cents:0}});
{const list=steps(finished,signed);assert.ok(list.every(s=>s.state==='done'),JSON.stringify(list.map(s=>s.key+':'+s.state)));
 const chip=ctx.encounterTimelineChip(list,'ENC-0002',{visit:'v1'});assert.match(chip,/class="encounter-chip-now">Closed</);
 assert.match(ctx.encounterTimelineMarkup(list,{title:'t'}),/7 of 7 done/);}
// No summary yet: only what the encounter and appointment say.
{const list=steps(null,open,{status:'scheduled'});assert.deepEqual(list.map(s=>s.key),['checkin','note','charges','closed']);assert.equal(list[0].state,'done','an encounter exists, so the patient is checked in');assert.equal(nowOf(list),'note');
 assert.equal(steps(null,null,{status:'scheduled'})[0].state==='now',true,'not checked in yet: check in is the step');}
// Markup: heading, one segment per step, aria label, count, escaping.
{const list=steps(insured({...posted,state:'fix_claim'}),signed);
 const html=ctx.encounterTimelineMarkup(list,{title:'ENC-0002 · <b>Follow-up</b>',subtitle:'Jan 2 · Synthetic "Health"'});
 assert.match(html,/<ol class="encounter-timeline">/);assert.match(html,/<li class="is-done"[^>]*aria-label="Done: Note signed\. time\(2030-01-02T09:40:00Z\)"/);
 assert.match(html,/aria-label="Now: Claim sent\. Needs fixing"/);assert.match(html,/class="is-later"/);assert.equal((html.match(/tabindex="0"/g)||[]).length,list.length);
 assert.doesNotMatch(html,/<b>Follow-up<\/b>/);assert.match(html,/&lt;b&gt;Follow-up/);assert.match(html,/Synthetic &quot;Health&quot;/);
 const done=list.filter(s=>s.state==='done').length;assert.match(html,new RegExp(`${done} of ${list.length} done`));}
// The chip carries the visit (and the patient, for rows of another patient), and names the step in hand.
{const list=steps(insured({...posted,state:'send_claim'}),signed);const chip=ctx.encounterTimelineChip(list,'ENC-0002',{visit:'v"1',patient:'p1'});
 assert.match(chip,/^<button type="button" class="encounter-chip" data-encounter-chip="v&quot;1" data-patient="p1"/);assert.match(chip,/class="encounter-chip-now">Claim sent</);assert.equal((chip.match(/<i class=/g)||[]).length,list.length);
 const plain=ctx.encounterTimelineChip(null,'ENC-0002',{visit:'v1'});assert.match(plain,/data-encounter-chip="v1"/);assert.match(plain,/ENC-0002<span class="encounter-chip-now">Open</);assert.doesNotMatch(plain,/<i /);}
// The preview takes the open encounter's summary from the page, with no second read.
(async()=>{
 let reads=0;const box={...ctx};
 const sheet={};
 const node=()=>({className:'',innerHTML:'',querySelector:sel=>sel==='[data-preview-timeline]'?sheet.timeline:sel==='[data-preview-open]'?{addEventListener(){}}:sel==='[data-preview-codes]'?sheet.codes:null});
 sheet.timeline={innerHTML:''};sheet.codes={innerHTML:''};
 const c2={esc,money:ctx.money,date:v=>String(v),displayTime:ctx.displayTime,displayDate:ctx.displayDate,visitBillingDate:ctx.visitBillingDate,encounterNumberText:ctx.encounterNumberText,document:{createElement:node},sheetOpen:()=>({isConnected:true}),sheetClose(){},run:f=>f(),openPatientEncounter(){},
  workspace:{visits:[signed],appointments:[appt]},selected:'p1',encounterRevenueState:{visit:'v1',data:{summary:insured({...posted,state:'send_claim'})}},api:async()=>{reads++;return null;},Number,Date};
 vm.createContext(c2);vm.runInContext(fs.readFileSync('web/encounter-timeline.js','utf8'),c2);
 await c2.encounterPreviewOpen('v1',{amount:'2500',date:'2030-01-02'});await new Promise(r=>setTimeout(r,0));
 assert.equal(reads,0,'the open encounter is not read again');assert.match(sheet.timeline.innerHTML,/Now: Claim sent\. Ready to send/);
 c2.encounterRevenueState.visit='other';await c2.encounterPreviewOpen('v1');await new Promise(r=>setTimeout(r,0));assert.equal(reads,1,'another encounter is read once');assert.match(sheet.timeline.innerHTML,/Now: Note signed|Now: Charges posted/,'with no answer the steps come from the encounter alone');
 console.log('PASS encounter timeline: now step per billing state, self-pay and no-copay steps, closed chip, markup, chip, preview');
})().catch(e=>{console.error(e);process.exit(1);});
