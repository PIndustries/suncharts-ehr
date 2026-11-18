// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The "What happened" timeline. The builder is pure, so these checks run on plain
// node with small stubs - no browser, no jsdom.
const assert=require('node:assert');
// Values crossing the vm boundary come from another realm, so compare content, not prototypes.
const eq=(actual,expected,message)=>{assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(expected)),message);};
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','web','claim-timeline.js'),'utf8');
const displaySource=fs.readFileSync(path.join(__dirname,'..','web','display-format.js'),'utf8');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function fixture(){
 const calls=[];
 const context={console,Date,Math,JSON,Intl,encodeURIComponent,Object,Array,String,Number,Boolean,Set,Map,Promise,Error,RegExp,
  esc,human:value=>String(value??'').replaceAll('_',' '),
  date:value=>new Date(value).toLocaleString(),
  money:cents=>`$${(Number(cents)/100).toFixed(2)}`,
  api:async(...args)=>{calls.push(args);throw new Error('unexpected provider call');}};
 vm.createContext(context);
 vm.runInContext(displaySource,context);
 vm.runInContext(source,context);
 return {context,calls,run:code=>vm.runInContext(code,context)};
}
// Reads back the day and clock time the timeline stored, in the machine's own zone,
// so the check does not depend on where the tests run.
function timelineClock(run,iso){
 return String(run(`(function(){const d=new Date(${JSON.stringify(iso)});return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()+' '+(d.getHours()<10?'0':'')+d.getHours()+':'+(d.getMinutes()<10?'0':'')+d.getMinutes();})()`));
}
const NOW=new Date('2026-11-18T17:00:00Z');
const sent={id:'sub-1',status:'delivered',created_at:'2026-11-12T09:00:00Z',interchange_control:'000000421',technical_status:'accepted',payer_outcome:'pending',partner_name:'Claim.MD'};
function claim(over={}){
 return {id:'claim-1',control_number:'SC-000123',payer_control_number:'ICN-998877',status:'submitted',updated_at:'2026-11-12T09:00:00Z',
  patient_id:'patient-1',account_id:'account-1',content:{},
  snapshot:{account:{coverage_snapshot:{payer:{content:{name:'Synthetic Health Plan'}}}}},...over};
}
function detail(over={}){
 return {tracking:{submissions:[sent],reports:[],connections:[],eligibility:null,remittance_posted:false,...over.tracking},...over};
}
const history={items:[{version:1,created_at:'2026-11-11T15:30:00Z',reason:'Claim created',evidence:{}}]};

(async()=>{
 const f=fixture();

 // A sent claim waiting on the payer: created, sent, and one plain status line.
 const waiting=f.context.buildClaimTimeline({claim:claim(),tracking:detail().tracking,history:[...history.items],now:NOW});
 eq(waiting.steps.map(step=>step.label),['Created','Sent to Claim.MD']);
 assert.strictEqual(waiting.steps[1].detail,'File 000000421 · Claim.MD');
 assert.match(waiting.current,/Waiting on the insurance company since Nov 12, 2026, 6 days/);
 assert.strictEqual(waiting.identifiers.payerControlNumber,'ICN-998877');
 eq(waiting.steps.map(step=>step.at),['2026-11-11T15:30:00.000Z','2026-11-12T09:00:00.000Z']);

 // A Claim.MD rejection keeps the provider's own words and the day count.
 const rejected=f.context.buildClaimTimeline({claim:claim({status:'rejected'}),history:[...history.items],now:NOW,
  tracking:{submissions:[sent],reports:[{received_at:'2026-11-14T10:00:00Z',evidence:{status:'R',senderid:'CLMMD',sender_name:'Claim.MD',message:{message:'Missing rendering provider NPI'},claimmd_id:'902000001'}}]}});
 const rejection=rejected.steps.at(-1);
 assert.strictEqual(rejection.label,'Rejected by Claim.MD');
 assert.strictEqual(rejection.detail,'Missing rendering provider NPI');
 assert.match(rejected.current,/Rejected since Nov 14, 2026, 4 days\. Missing rendering provider NPI/);
 assert.strictEqual(rejected.identifiers.claimMdClaimId,'902000001');

 // Forwarded to the payer, then accepted by the payer with its claim number.
 const forwarded=f.context.buildClaimTimeline({claim:claim({status:'accepted'}),now:NOW,history:[...history.items],
  tracking:{submissions:[sent],reports:[
   {received_at:'2026-11-12T11:00:00Z',evidence:{status:'A',senderid:'CLMMD',sender_name:'Claim.MD',message:{message:'Claim forwarded to payer'}}},
   {received_at:'2026-11-15T08:00:00Z',evidence:{status:'A',senderid:'P7',sender_name:'Synthetic Health Plan',sender_icn:'ICN-998877',message:{message:'Claim accepted'}}}]}});
 eq(forwarded.steps.map(step=>step.label).slice(2),['Accepted by Claim.MD','Forwarded to the insurance company']);
 assert.match(forwarded.current,/Waiting on the insurance company since Nov 15, 2026, 3 days/);

 // A 277CA acknowledgment is shown with its category, action and reason in words.
 const acknowledged=f.context.buildClaimTimeline({claim:claim({status:'rejected'}),now:NOW,history:[...history.items],tracking:{submissions:[sent],reports:[]},
  ca277Rows:[{control:'SC-000123',received_at:'2026-11-16T09:00:00Z',payer_control:'ICN-998877',statuses:[
   {category:'A2',code:'A2',entity:'P7',date:'20261115',action:'WQ',message:'Claim received and accepted'},
   {category:'A3',code:'N208',entity:'P7',date:'20261116',action:'KH',message:'Service date is outside the plan period'}]}]});
 const ack=acknowledged.steps.filter(step=>step.label.startsWith('Insurance acknowledgment'));
 assert.strictEqual(ack.length,2);
 assert.strictEqual(ack[1].label,'Insurance acknowledgment (277CA) · Claim rejected');
 assert.match(ack[1].detail,/Reason: Service date is outside the plan period/);
 assert.match(ack[1].detail,/Hold - action needed from us/);
 eq(ack[1].rows[0],{label:'Status',value:'Claim rejected (A3)',raw:'category: A3'});

 // Claim.MD website notes and edits arrive as labelled rows, not raw JSON.
 const edited=f.context.buildClaimTimeline({claim:claim(),now:NOW,history:[...history.items],tracking:{submissions:[sent],reports:[]},
  claimMdRecords:[{kind:'note',remote_id:'7',claimmd_id:'902000001',recorded_at:'2026-11-13T12:00:00Z',content:{noteid:'7',notedate:'2026-11-13',notetime:'14:05',user:'clinic.user',note:'Payer call reference 5150'}}]});
 const note=edited.steps.find(step=>step.label==='Note added on the Claim.MD website');
 // The provider's own clock is shown as a wall clock, not shifted by a time zone.
 assert.match(timelineClock(f.run,note.at),/2026-11-13 14:05/);
 eq(note.rows,[
  {label:'Claim.MD claim ID',value:'902000001',raw:'claimmd_id: 902000001'},
  {label:'Claim.MD note ID',value:'7',raw:'noteid: 7'},
  {label:'Date of the note',value:'2026-11-13',raw:'notedate: 2026-11-13'},
  {label:'Time of the note',value:'14:05',raw:'notetime: 14:05'},
  {label:'Written by',value:'clinic.user',raw:'user: clinic.user'},
  {label:'Note',value:'Payer call reference 5150',raw:'note: Payer call reference 5150'}]);
 // The record type and its provider ID are the step heading, not repeated rows.
 assert.ok(!note.rows.some(row=>row.label==='Record type'||row.label==='Provider record ID'));

 // Paid, posted and billed, in order, with the three amounts the payer reported.
 const paid=f.context.buildClaimTimeline({claim:claim({status:'adjudicated'}),now:NOW,history:[...history.items],
  tracking:{submissions:[sent],reports:[],remittance_posted:true},
  era:{remittance:{id:'era-1',status:'posted',trace:'TRACE-88',payment_date:'2026-11-16',posted_at:'2026-11-17T09:00:00Z'},
   row:{status:'1',charged_cents:12550,paid_cents:8000,patient_responsibility_cents:2000,payer_control_number:'ICN-998877',
    adjustments:[{group:'CO',reason_code:'45',amount_cents:2550},{group:'PR',reason_code:'3',amount_cents:2000}]}},
  invoices:[{id:'inv-1',created_at:'2026-11-17T16:00:00Z',snapshot:{amount_due_cents:2000,responsibility_cents:2000}}]});
 eq(paid.steps.map(step=>step.label).slice(-3),['Payment received (ERA)','Posted','Patient billed']);
 const payment=paid.steps.find(step=>step.label==='Payment received (ERA)');
 assert.match(payment.detail,/Paid \$80\.00 · patient responsible \$20\.00 · payer says: Claim reviewed and paid/);
 eq(payment.detailExtra,['Charge exceeds the fee schedule · Contractual adjustment (CO) · code 45','Co-payment amount · Patient responsibility (PR) · code 3']);
 assert.match(paid.current,/The patient was billed since Nov 17, 2026, 1 day/);
 const posted=paid.steps.find(step=>step.label==='Posted');
 assert.strictEqual(posted.at,'2026-11-17T09:00:00.000Z');

 // A reversed payment is called out instead of reading as paid.
 const reversed=f.context.buildClaimTimeline({claim:claim({status:'adjudicated'}),now:NOW,history:[...history.items],tracking:{submissions:[sent],reports:[]},
  era:{remittance:{id:'era-2',status:'posted',trace:'TRACE-89',payment_date:'2026-11-15'},row:{status:'22',paid_cents:8000,patient_responsibility_cents:0,adjustments:[]}}});
 assert.ok(reversed.steps.some(step=>step.label==='Payment reversed'));
 assert.match(reversed.current,/The payer reversed the payment since Nov 15, 2026, 2 days/);

 // Rendering: one large line, copyable identifiers, no bare JSON in the body.
 const html=f.context.claimTimelineMarkup(paid);
 assert.match(html,/class="claim-timeline"/);
 assert.match(html,/Paid \$80\.00/);
 assert.match(html,/ICN-998877<\/code><small>Payer claim number/);
 assert.match(html,/Show technical details/);
 assert.ok(!/\bundefined\b|\[object Object\]/.test(html),'markup must not leak unresolved values');
 assert.ok(html.indexOf('Show technical details')<html.length,'technical data stays behind a disclosure');
 assert.strictEqual(f.context.claimTimelineMarkup(f.context.buildClaimTimeline({claim:{status:'draft'},now:NOW})).includes('undefined'),false);

 // Provider reads happen through the existing endpoints, once per claim, and are cached.
 const calls=[];
 f.context.stubApi=async(...args)=>{calls.push(args);
  if(args[0].endsWith('/notes/sync')||args[0].endsWith('/modifications/sync'))return {inserted:0};
  if(args[0].endsWith('/operations'))return {records:[
   {kind:'note',remote_id:'7',claimmd_id:'902000001',recorded_at:'2026-11-13T12:00:00Z',content:{pcn:'SC-000123',note:'Payer call reference 5150'}},
   {kind:'note',remote_id:'8',claimmd_id:'902000002',recorded_at:'2026-11-13T12:30:00Z',content:{pcn:'SC-999999',note:'Another patient note'}}]};
  if(args[0].includes('/invoices'))return {items:[{id:'inv-1',created_at:'2026-11-17T16:00:00Z',snapshot:{amount_due_cents:2000,responsibility_cents:2000}}]};
  if(args[0].endsWith('/era-history'))return {active_head:{remittance_id:'era-1',row_index:0,status:'posted'},items:[{remittance_id:'era-1',row_index:0,status:'posted'}]};
  if(args[0].endsWith('/history'))return {items:[{version:3,status:'posted',created_at:'2026-11-17T09:00:00Z'}]};
  if(args[0].includes('/remittances/'))return {remittance:{id:'era-1',status:'posted',trace:'TRACE-88',payment_date:'2026-11-16',document:{claims:[{status:'1',charged_cents:12550,paid_cents:8000,patient_responsibility_cents:2000,adjustments:[]}]}},postings:[{remittance_id:'era-1'}]};
  if(args[0]==='/api/v1/billing/277ca')return {items:[]};
  throw new Error('unexpected '+args[0]);};
 const openTimeline=()=>f.run(`claimTimelineSection(${JSON.stringify(claim())},${JSON.stringify(detail())},${JSON.stringify(history)},{now:new Date(${NOW.getTime()}),api:stubApi,connection:{id:'setting-1'}})`);
 const section=await openTimeline();
 assert.match(section,/Note added on the Claim\.MD website/);
 assert.match(section,/Payment received \(ERA\)/);
 assert.match(section,/Patient billed/);
 assert.match(section,/Paid \$80\.00/);
 assert.ok(calls.some(call=>call[0]==='/api/v1/billing/claimmd/setting-1/notes/sync'&&call[1]==='POST'));
 assert.ok(calls.some(call=>call[0]==='/api/v1/billing/claims/claim-1/era-history'));
 const before=calls.length;
 assert.strictEqual(await openTimeline(),section);
 assert.strictEqual(calls.length,before,'a cached claim must not call the provider again');

 // A Claim.MD outage degrades to a plain note; the claim screen still renders.
 f.context.stubApi=async()=>{throw new Error('provider down');};
 const offline=await f.run(`claimTimelineSection(${JSON.stringify(claim())},${JSON.stringify(detail())},${JSON.stringify(history)},{now:new Date(${NOW.getTime()}),api:stubApi,connection:null,refresh:true})`);
 assert.match(offline,/could not be loaded/);
  assert.ok(!/undefined|\[object Object\]|NaN/.test(offline),offline);
 // A provider record naming a different claim never joins this claim's timeline.
 assert.ok(!section.includes('Another patient note'),section);
 // Matching is by claim identity, and a bare provider claim ID is never guessed at:
 // the same numeric ID can appear on another tenant's record.
 assert.strictEqual(f.context.claimMdRecordBelongsToClaim({patient_control_number:'SC-000123',content:{}},claim()),true);
 assert.strictEqual(f.context.claimMdRecordBelongsToClaim({claimmd_id:'902000001',content:{}},claim()),false,'a claim ID alone does not attach a note');
 assert.strictEqual(f.context.claimMdRecordBelongsToClaim({content:{pcn:'SC-000124'}},claim()),false,'a note naming another control number does not attach');
 assert.strictEqual(f.context.claimMdRecordBelongsToClaim({content:{claimid:'ICN-998873'}},claim()),false);

// Records are matched by the same identity rule the Claim.MD activity panel uses.
 assert.strictEqual(f.context.claimMdRecordBelongsToClaim({claimmd_id:'902000001',content:{pcn:'SC-000123'}},claim()),true);
 assert.strictEqual(f.context.claimMdRecordBelongsToClaim({claimmd_id:'9',content:{pcn:'OTHER'}},claim()),false);

 // Nothing sent yet: the timeline stays honest instead of inventing steps.
 const draft=f.context.buildClaimTimeline({claim:claim({status:'draft'}),history:[...history.items],now:NOW,tracking:{submissions:[],reports:[]}});
 eq(draft.steps.map(step=>step.label),['Created']);
 assert.strictEqual(draft.current,'This claim has not been sent yet.');

 // Claim.MD activity 'Details' views now render labelled fields, raw data only on request.
 // The Claim.MD activity screens load claim-timeline.js first, exactly as index.html does.
 const activityScope={console,Date,Math,JSON,Object,Array,String,Number,Boolean,Set,Map,Promise,Error,RegExp,Intl,
  esc,human:value=>String(value??'').replaceAll('_',' '),date:value=>String(value),
  money:cents=>`$${(Number(cents)/100).toFixed(2)}`,me:{role:'owner'},document:{addEventListener(){}},location:{origin:'https://ehr.synthetic.test'}};
 const activity=vm.createContext(activityScope);
 // Inside the page each script is top-level, so a const in one is visible to the next.
 // globalThis is how that sharing is reached across separate vm.runInContext calls.
 activityScope.globalThis=activityScope;
 // The Claim.MD activity screens load claim-timeline.js first, exactly as index.html does.
 for(const file of ['web/claim-timeline.js','web/claimmd-operations.js','web/claimmd-extended.js'])
  vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),activity);
 const ops=activity,ext=activity;
 const noteCell=ops.claimmdRecords([{kind:'note',remote_id:'9',claimmd_id:'9001',recorded_at:'2026-11-13T10:00:00Z',content:{noteid:'9',notedate:'2026-11-12',user:'clinic.user',note:'Payer call reference <5150>'}}],'note');
 assert.match(noteCell,/Claim\.MD note ID<\/th><td>9<\/td>/);
 assert.match(noteCell,/Note<\/th><td>Payer call reference &lt;5150&gt;<\/td>/);
 assert.match(noteCell,/Show technical details/);
 assert.ok(!/summary>Details<\/summary><pre/.test(noteCell),'the Details view must not open on raw JSON');
 const uploadCell=ops.claimmdRecords([{kind:'uploaded_file',remote_id:'55',recorded_at:'2026-11-02T08:00:00Z',content:{filename:'synthetic-claim.x12',pcn:'SC-000123',upload_date:'2026-11-02'}}],'uploaded_file');
 assert.match(uploadCell,/File<\/th><td>synthetic-claim\.x12<\/td>/);
 assert.match(uploadCell,/Uploaded on<\/th><td>2026-11-02<\/td>/);
 const archiveCell=ops.claimmdRecords([{kind:'archive',remote_id:'a1',recorded_at:'2026-11-04T08:00:00Z',reason:'Closed out in Claim.MD',content:{}}],'archive');
 assert.match(archiveCell,/Details/,'an archive row still offers its record');
 const events=ext.claimMdEventRows([{event_id:'e1',received_at:'2026-11-13T10:00:00Z',account_number:'ACCT-77123',payload:{type:'enrollment_approved',status:'A'}}]);
 assert.match(events,/Enrollment approved/);
 assert.match(events,/Claim\.MD account ending 7123/,'never print a whole Claim.MD account number');
 assert.ok(!events.includes('ACCT-77123'),events);
 assert.match(events,/Status<\/th><td>Accepted<\/td>/);
 assert.match(events,/Show technical details/);

	// Mounting: the claim screen gets its own timeline container, above the lifecycle
	// panel, and never lets a slow provider write a stale claim's timeline into it.
	// The claim screen is re-rendered, so the container the timeline writes into is the
	// node the fixture last handed back - like an element appended to a live document.
	function mountingScreen(extra){
	 const panel={created:[],insertAdjacentHTML(position,html){panel.created.push({position,html});}};
	 panel.slot={isConnected:true,innerHTML:''};

	 // Mirrors the real claim screen: the lifecycle panel and the timeline container both
	 // live inside .billing-account-detail, and the workspace host returns that section.
	 const account={querySelector(selector){
	  if(selector==='[data-claim-problem-box]')return account.problem||null;
	  if(selector.split(',').some(name=>name.trim()==='.claim-lifecycle'))return panel;
	  if(selector==='[data-claim-timeline]')return panel.slot;
	  return null;
	 }};
	 const host={querySelector:selector=>{
	  if(selector==='[data-claim-timeline]')return panel.slot;
	  if(selector==='[data-claim-problem-box]')return account.problem||null;
	  if(selector==='.billing-account-detail')return account;
	  if(selector.includes('.claim-lifecycle'))return panel;
	  return null;
	 }};
	 const scope={console,Date,Math,JSON,Object,Array,String,Number,Boolean,Set,Map,Promise,Error,RegExp,Intl,
	  esc,human:value=>String(value??''),date:value=>String(value),money:value=>`$${value}`,document:{addEventListener(){}},
	  claimWorkspaceHost:()=>host,...extra};
	 // The browser puts every script's declarations in one shared global scope; the same
	 // trick here lets the stub timeline be seen by the claims.js top-level const.
	 const context=vm.createContext(scope);
	 // scope.globalThis is the sandbox's own global, so globalThis lookups in the code
	 // under test reach the same objects the test installed.
	 scope.$=()=>host;scope.host=host;scope.panel=panel;
	 vm.runInContext(fs.readFileSync(path.join(__dirname,'..','web','display-format.js'),'utf8')+'\n'+fs.readFileSync(path.join(__dirname,'..','web','claims.js'),'utf8'),context);
	 return {panel,account,host,context};   // account.problem: hang a rejection box on the pane
	}

	// The claim on screen is the claim the timeline is built for - the guard below this
	// point refuses to paint a timeline for any other claim.
	const shown={id:'claim'};
	const fresh=mountingScreen({claimTimelineSection:async()=>'<section class="claim-timeline">built</section>'});
	fresh.context.claimCurrent=shown;
	await fresh.context.insertClaimStatusTimeline({}, shown, {}, {});

	assert.equal(fresh.panel.created[0].position,'beforebegin','the timeline container is inserted before the lifecycle panel');
	assert.match(fresh.panel.created[0].html,/data-claim-timeline/);
	assert.match(fresh.panel.slot.innerHTML,/built/,'the awaited timeline is written into its own container');

	// With the rejection box on screen, the timeline goes under the box, not the panel.
	// mountingScreen has no box unless the scenario places one, as the real pane does.
	const boxed=mountingScreen({claimTimelineSection:async()=>'built'});
	const box={created:[],insertAdjacentHTML(position,html){box.created.push({position,html});}};
	boxed.account.problem=box;
	boxed.context.claimCurrent=shown;
	await boxed.context.insertClaimStatusTimeline({}, shown, {}, {});
	assert.equal(box.created[0]?.position,'afterend','the timeline container is inserted directly after the rejection box');
	assert.equal(boxed.panel.created.length,0,'the lifecycle panel is not the anchor when the rejection box is on screen');

	// A provider that will not answer leaves the container readable, not broken.
	const stuck=mountingScreen({claimTimelineSection:async()=>{throw new Error('provider down');}});
	stuck.context.claimCurrent=shown;
	await stuck.context.insertClaimStatusTimeline({}, shown, {}, {});
	assert.match(stuck.panel.slot.innerHTML,/not available right now/);

	// If another claim is on screen by the time the provider answers, nothing is written.
	let release;
	const late=mountingScreen({claimTimelineSection:()=>new Promise(resolve=>{release=()=>resolve('<section class="claim-timeline">late</section>');})});
	late.context.me={role:'clinician'};late.context.claimCurrent={id:'a-different-claim'};
	const pendingStale=late.context.insertClaimStatusTimeline({}, 'claim', {}, {});
	release();await pendingStale;
	assert.equal(late.panel.slot.innerHTML,'','a timeline for a claim no longer on screen must not be written');

	// Without the timeline script the claim screen still opens (script order tolerance).
	const absent=mountingScreen({});
	await absent.context.insertClaimStatusTimeline({}, shown, {}, {});
	assert.equal(absent.panel.created.length,0);


 console.log('PASS claim status timeline builds plain-language steps, waits and provider evidence');
})().catch(error=>{console.error(error);process.exitCode=1;});
