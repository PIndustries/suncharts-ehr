// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const claimsBase='/api/v1/billing/claims';
const eraBase='/api/v1/billing/remittances';
const coverageBase='/api/v1/billing/coverage-needs-action';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const claim=(n,status,fields={})=>({
 id:id(n),patient_name:'Synthetic Patient',patient_id:id(100+n),account_id:id(200+n),
 control_number:`SYN-${n}`,payer_name:'Synthetic Payer',frequency:'original',
 service_date:'2026-11-01',status,total_cents:10000,snapshot:{account:{content:{}}},...fields
});
const payment=(n,status)=>({
 id:id(n),payer_name:'Synthetic Payer',trace:'Shared trace',status,
 payment_date:'2026-11-15',total_paid_cents:2000,claim_count:1,version:2
});
const claims=[
 claim(1,'draft'),claim(2,'ready'),claim(3,'submitted',{claimmd_position:{acknowledged:true}}),
 claim(4,'accepted'),claim(5,'submitted',{claimmd_position:{needs_correction:true}}),
 claim(6,'rejected'),claim(7,'adjudicated',{remittance_posted:true,payer_denied:false,paid_cents:2000}),claim(8,'adjudicated'),
 claim(9,'submitted',{crossover_tracking_only:true}),
 claim(10,'void',{claimmd_position:{needs_correction:true}}),claim(11,'paid')
];
const remittances=[payment(30,'staged'),payment(31,'reconciled'),payment(32,'posted'),
 payment(33,'reversed'),payment(34,'rejected'),payment(35,'unrecognized')];

function fixture({write=true,claimRows=claims,remittanceRows=remittances,history=false}={}){
 const dom=new JSDOM('<nav id="workspace-navigation"><button id="nav-claims"></button></nav><div id="clinical-workspace" hidden></div><div id="tools"></div>',{runScripts:'outside-only',pretendToBeVisual:true,url:'https://suncharts.test/'});
 const ctx=dom.getInternalVMContext(),doc=ctx.document,calls=[],routes=new Map(),opened=[],panels=[];
 const $=name=>doc.getElementById(name);
 let pageClaims=claimRows,pageEras=remittanceRows,nextClaims=null,nextEras=null,afterClaims=[],afterEras=[];
 ctx.HTMLElement.prototype.scrollIntoView=function(){};
 ctx.scrollTo=()=>{};
 Object.assign(ctx,{
  $,me:{user_id:'synthetic-staff',tenant_id:'synthetic-tenant',role:write?'owner':'nurse'},
  esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
  encounterNumberLabel:sequence=>sequence?`ENC-${String(sequence).padStart(4,'0')}`:'',
  money:value=>`$${(value/100).toFixed(2)}`,human:String,notice(){},billingWrite:()=>write,
  billingPayers:[],payerName:()=> 'Synthetic Payer',billingField:()=> '<input name="reason">',
  showTool:()=>{$('nav-claims').setAttribute('aria-current','page');$('tools').hidden=false;$('clinical-workspace').hidden=true;},captureVisitDrafts(){},busy:false,
  claimMdConnectionState:{connected:true},loadClaimMdConnection:async()=>({connected:true}),
  showEraAutomation:async()=>panels.push('automation'),showRecoupments:async()=>panels.push('recoupments'),
  showEraBatches:async()=>panels.push('batch'),showProviderSettlement:async key=>panels.push(key),
  showClinical:async()=>opened.push(['chart']),
  selectPatient:async (p,visit)=>{opened.push([p,visit]);ctx.selected=p;ctx.activeVisit={id:visit};},
  setEncounterSection:step=>opened.push([step]),
  run:action=>{ctx.pending=action();return ctx.pending.catch(()=>{});},
  async api(path,method='GET'){
   calls.push([path,method]);
   if(routes.has(path))return await routes.get(path)();
   if(path===claimsBase)return {items:pageClaims.map(c=>({...c})),next_cursor:nextClaims};
   if(path===`${claimsBase}?after=${encodeURIComponent(nextClaims)}`)return {items:afterClaims.map(c=>({...c})),next_cursor:null};
   if(path===eraBase)return {items:[...pageEras],next_cursor:nextEras};
   if(path===`${eraBase}?after=${encodeURIComponent(nextEras)}`)return {items:[...afterEras],next_cursor:null};
   if(path===coverageBase)return {items:[],can_apply_coverage:write,can_prepare_claim:write};
   if(path==='/api/v1/billing/payers')return {items:[]};
   if(path==='/api/v1/billing/remittance-sources')return {items:[{source_history_id:id(40),source_id:'Synthetic import',source_instance:'Archive'}]};
   if(path.startsWith(claimsBase+'/')){
    if(path.endsWith('/history'))return {items:[]};
    const key=path.slice(claimsBase.length+1),row=[...pageClaims,...afterClaims].find(c=>c.id===key);
    assert.ok(row,`Fixture claim ${key} must exist`);
    return {claim:row,canceled_claim_recovery:row.canceled_claim_recovery,tracking:{remittance_posted:row.remittance_posted===true}};
   }
   if(path.startsWith(eraBase+'/')){
    if(path.endsWith('/history'))return {items:[]};
    const key=path.slice(eraBase.length+1),row=[...pageEras,...afterEras].find(r=>r.id===key);
    assert.ok(row,`Fixture remittance ${key} must exist`);
    return {remittance:{...row,matches:[],document_hash:'synthetic-hash',document:{
     claims:[],payment_date:row.payment_date,total_paid_cents:row.total_paid_cents,currency:'USD',payer_code:'SYN'
    }},issues:[],postings:[],ready_to_post:row.status==='reconciled'};
   }
   throw new Error(`Unexpected API ${path}`);
  }
 });
 for(const file of ['display-format.js','visit-billing.js','claim-problems.js','claims.js'])vm.runInContext(fs.readFileSync('web/'+file,'utf8'),ctx);
 // Exercise the real record-loader and its guards with a lightweight claim-detail template.
 ctx.claimScreenMarkup=row=>`<p data-opened-claim="${row.id}">${row.control_number}</p>`;
 ctx.showEncounterClaim=async (key,account)=>opened.push([key,account]);
 if(history)vm.runInContext(fs.readFileSync('web/navigation-history.js','utf8'),ctx);
 const $q=selector=>doc.querySelector(selector);
 const stage=key=>$q(`[data-claim-status="${key}"]`);
 const stageCounts=()=>Object.fromEntries(Array.from(doc.querySelectorAll('[data-claim-status]'),button=>[button.dataset.claimStatus,Number(button.querySelector('span').textContent)]));
 const visibleRows=kind=>Array.from(doc.querySelectorAll(`[data-${kind==='claim'?'claim':'era'}-worklist]:not([hidden]) [data-${kind}-open]`),button=>button.dataset[kind+'Open']);
 const choose=value=>{const select=$('billing-all-claims');select.value=value;select.dispatchEvent(new ctx.Event('change',{bubbles:true}));};
 const click=selector=>{$q(selector).click();return ctx.pending;};
 return {ctx,dom,calls,paths:()=>calls.map(([path])=>path),routes,opened,panels,$,$q,stage,stageCounts,visibleRows,choose,click,
  setClaims:(rows,next=null,after=[])=>{pageClaims=rows;nextClaims=next;afterClaims=after;},
  setRemittances:(rows,next=null,after=[])=>{pageEras=rows;nextEras=next;afterEras=after;}};
}
const hasIds=(f,kind,ids)=>assert.deepEqual(f.visibleRows(kind),ids.map(id));
const waitFor=async test=>{
 for(let attempt=0;attempt<30;attempt++){
  if(test())return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('The expected navigation state did not appear');
};

(async()=>{
 const f=fixture();
 f.setClaims(claims,'claims cursor',[claim(12,'accepted',{claimmd_position:{needs_correction:true}})]);
 f.setRemittances(remittances,'payments cursor',[payment(36,'posted'),payment(37,'staged')]);
 await f.ctx.showClaimsWorkspace();
 assert.deepEqual(f.stageCounts(),{action:5,send:2,wait:2,fix:3,'remittance-review':2,posted:1});
 assert.deepEqual(Array.from(f.ctx.document.querySelectorAll('[data-claim-status]'),button=>button.firstChild.textContent.trim()),
  ['Needs action','To send','Waiting','Needs correction','Remittance to review','Posted']);
 assert.equal(f.stage('action').getAttribute('aria-pressed'),'true');
 assert.equal(f.$('nav-claims').getAttribute('aria-current'),'page');
 assert.ok(f.paths().includes(claimsBase+'?after=claims%20cursor'));
 assert.ok(!f.paths().includes(claimsBase+'/status-counts'));
 assert.ok(!f.paths().some(path=>path.startsWith(claimsBase+'/')),'worklist payment state comes from the list response');
 hasIds(f,'claim',[1,2,5,6,12]);hasIds(f,'era',[]);
 assert.equal(f.$q('[data-claim-waiting]').hidden,false);
 assert.equal(f.$q('[data-claim-waiting-count]').textContent,'2');
 const queries=f.calls.length;
 f.stage('wait').focus();f.stage('wait').click();
 assert.equal(f.ctx.document.activeElement,f.stage('wait'));
 hasIds(f,'claim',[3,4]);
 assert.match(f.$q('[data-claim-worklist]').textContent,/Received by the clearinghouse/);
 f.stage('fix').click();hasIds(f,'claim',[5,6,12]);
 f.stage('remittance-review').click();hasIds(f,'era',[30,31]);hasIds(f,'claim',[]);
 assert.equal(f.$('nav-claims').getAttribute('aria-current'),'page','remittance filters stay in Claims & remittances');
 f.stage('posted').click();hasIds(f,'era',[32]);
 f.choose('payments');hasIds(f,'era',[30,31,32,33,34,35]);
 assert.match(f.$q(`[data-era-open="${id(35)}"]`).closest('tr').textContent,/Status unavailable/);
 f.choose('all');hasIds(f,'claim',[1,2,3,4,5,6,7,8,9,10,11,12]);
 assert.match(f.$q(`[data-claim-open="${id(7)}"]`).closest('tr').textContent,/Payment posted/);
 assert.match(f.$q(`[data-claim-open="${id(8)}"]`).closest('tr').textContent,/Insurer answered/);
 assert.match(f.$q(`[data-claim-open="${id(11)}"]`).closest('tr').textContent,/Claim status unavailable/);
 f.choose('void');hasIds(f,'claim',[10]);
 assert.equal(f.calls.length,queries,'stage changes only filter the returned records');
 assert.match(f.$q('[data-era-more]').textContent,/counts reflect loaded records/);
 f.stage('posted').click();
 await f.click('[data-era-next]');
 assert.ok(f.paths().includes(eraBase+'?after=payments%20cursor'));
 assert.deepEqual(f.stageCounts(),{action:5,send:2,wait:2,fix:3,'remittance-review':3,posted:2});
 hasIds(f,'era',[32,36]);assert.equal(f.$q('[data-era-more]').hidden,true);
 assert.deepEqual(f.panels,['automation','recoupments','batch']);
 assert.ok(f.$q('[data-era-source]'));assert.ok(f.$q('[data-payment-settings]'));
 await f.ctx.showClaimsWorkspace({filter:'send'});hasIds(f,'claim',[1,2]);
 await f.ctx.showClaimsWorkspace({filter:'payments'});hasIds(f,'era',[30,31,32,33,34,35,36,37]);
 console.log('PASS action-first worklist, precise counts and states, shortcuts, older remittances, and legacy management');

 const empty=fixture({claimRows:[],remittanceRows:[payment(35,'unrecognized')]});
 empty.setRemittances([payment(35,'unrecognized')],'next',[payment(32,'posted')]);
 await empty.ctx.showClaimsWorkspace();
 assert.deepEqual(empty.stageCounts(),{action:0,send:0,wait:0,fix:0,'remittance-review':0,posted:0});
 assert.match(empty.$q('[data-claim-worklist]').textContent,/No claims need staff action/);
 empty.stage('fix').click();assert.match(empty.$q('[data-claim-worklist]').textContent,/No claims need correction/);
 empty.stage('posted').click();assert.match(empty.$q('[data-era-worklist]').textContent,/No posted remittances in the loaded records/);
 await empty.click('[data-era-next]');hasIds(empty,'era',[32]);
 empty.stage('remittance-review').click();assert.match(empty.$q('[data-era-worklist]').textContent,/No remittances to review\./);
 console.log('PASS empty and unknown states, including a zero count on a partial list');

 const actions=fixture({history:true});
 await actions.ctx.showClaimsWorkspace({filter:'remittance-review'});
 await actions.click(`[data-era-open="${id(31)}"]`);
 assert.equal(actions.ctx.eraCurrent.id,id(31));
 assert.equal(actions.ctx.location.hash,`#/remittances/${id(31)}`);
 assert.deepEqual(Array.from(actions.$('era-action').querySelectorAll('option'),option=>option.value),['post','reject']);
 actions.ctx.history.back();
 await waitFor(()=>actions.ctx.location.hash==='#/claims/remittance-review'&&!actions.$('era-action'));
 assert.equal(actions.stage('remittance-review').getAttribute('aria-pressed'),'true');
 actions.ctx.history.forward();
 await waitFor(()=>actions.$('era-action')&&actions.ctx.eraCurrent.id===id(31));
 await new Promise(resolve=>actions.ctx.requestAnimationFrame(()=>actions.ctx.requestAnimationFrame(resolve)));
 actions.stage('posted').click();await actions.click(`[data-era-open="${id(32)}"]`);
 assert.equal(actions.$('era-action').querySelector('option').value,'reverse');
 actions.choose('payments');await actions.click(`[data-era-open="${id(35)}"]`);
 assert.match(actions.$('claims-detail').textContent,/Payment status unavailable/);
 assert.doesNotMatch(actions.$('claims-detail').textContent,/Payment file rejected/);
 assert.equal(actions.$('era-action'),null);
 actions.stage('send').click();
 await actions.click(`[data-claim-open="${id(2)}"]`);
 assert.equal(actions.ctx.claimCurrent.id,id(2));assert.equal(actions.ctx.location.hash,`#/claims/${id(2)}`);
 assert.ok(actions.$q(`[data-opened-claim="${id(2)}"]`));
 actions.routes.set(claimsBase+'/'+id(1),()=>({claim:claims[1]}));
 await assert.rejects(actions.click(`[data-claim-open="${id(1)}"]`),/does not match the selected claim/);
 assert.ok(actions.$q(`[data-opened-claim="${id(2)}"]`));
 assert.ok(actions.calls.every(([,method])=>method==='GET'));
 const readOnly=fixture({write:false});
 await readOnly.ctx.showClaimsWorkspace({filter:'remittance-review'});
 await readOnly.click(`[data-era-open="${id(31)}"]`);
 assert.equal(readOnly.ctx.eraCurrent.id,id(31));assert.equal(readOnly.$('era-action'),null);
 assert.equal(readOnly.$q('[data-payment-settings]'),null);
 assert.ok(!readOnly.paths().includes('/api/v1/billing/remittance-sources'));
 const visit=fixture({claimRows:[claim(1,'draft',{snapshot:{account:{content:{visit_id:id(400)}}}})]});
 await visit.ctx.showClaimsWorkspace();
 await visit.click(`[data-claim-open="${id(1)}"]`);
 assert.deepEqual(visit.opened,[['chart'],[id(101),id(400)],['charges'],[id(1),id(201)]]);
 console.log('PASS exact claim, encounter and remittance IDs, Back and Forward, and writer-only remittance actions');

 const hold=claim(61,'submitted',{service_date:'2026-11-27',snapshot:{account:{content:{visit_id:id(461)}}},claimmd_position:{needs_correction:true,correction:{at:'2026-11-25T08:00:00Z',line:{index:0,code:'64405'},message:'NCCI - Procedure Code [64405] requires an appropriate modifier when procedure [20553] present.'}}});
 const reasons=fixture({claimRows:[hold,
  claim(71,'rejected',{worklist_return_reason:'Code 496 - Submitter not approved for electronic claim submissions on behalf of this entity.Billing Provider'}),
  claim(72,'rejected',{worklist_return_reason:'Code 25 - <img src=x> '+ 'A'.repeat(200)}),
  claim(73,'rejected'),claim(74,'adjudicated',{payer_denied:true,worklist_denial_codes:['CO-16','<img src=x>']}),
  claim(75,'accepted',{worklist_return_reason:'Old response must stay hidden'})]});
 await reasons.ctx.showClaimsWorkspace({filter:'all'});
 const rowReason=n=>reasons.$q(`[data-claim-open="${id(n)}"]`).closest('tr').querySelector('[data-claim-response-reason]');
 assert.equal(rowReason(61).textContent,'64405 needs a modifier when billed with 20553');
 assert.equal(rowReason(71).textContent,'Code 496 · Submitter not approved for this billing provider');
 assert.match(rowReason(72).textContent,/^Code 25 - <img src=x>/);
 assert.equal(rowReason(72).querySelector('img'),null);
 assert.match(rowReason(72).textContent,/…$/);
 assert(rowReason(72).textContent.length<=160);
 assert.equal(rowReason(73).textContent,'No return reason recorded');
 assert.equal(rowReason(74).textContent,'Remittance adjustment CO-16');
 assert.equal(rowReason(75),null);
 assert(!reasons.paths().some(path=>path.startsWith(claimsBase+'/')),'reasons are already in the worklist response');
 console.log('PASS compact return, hold and remittance reasons without extra requests or unescaped messages');
 const zip=claim(62,'draft',{service_date:'2026-11-21',status_at:'2026-11-27T09:00:00Z',snapshot:{account:{content:{visit_id:id(462)}}},worklist_issue:{field:'subscriber_address',part:'postal_code',message:'Policyholder ZIP code is missing'}});
 const unconfirmed=claim(63,'ready',{claim_handoff:{delivery_status:'unknown',outcome:'waiting',attempt_at:'2026-11-26T12:00:00Z'},snapshot:{account:{content:{visit_id:id(463)}}}});
 const matched=payment(64,'reconciled');
 const paidRow=claim(64,'accepted',{worklist_remittance:{id:matched.id,at:'2026-11-27T09:15:00Z',row_index:0}});
 const guided=fixture({claimRows:[zip,paidRow,unconfirmed,hold,claim(65,'submitted')],remittanceRows:[matched]});
 guided.ctx.document.body.insertAdjacentHTML('beforeend','<div id="visit-page-host"></div>');
 const visits=[];
 guided.ctx.visitOpenCurrentEncounterClaim=async (...args)=>{visits.push(JSON.parse(JSON.stringify(args)));return true;};
 await guided.ctx.showClaimsWorkspace();
 hasIds(guided,'claim',[61,63,62]);
 assert.deepEqual(Array.from(guided.ctx.document.querySelectorAll('[data-claim-worklist] tbody tr time'),node=>node.dateTime),['2026-11-25T08:00:00Z','2026-11-26T12:00:00Z','2026-11-27T09:00:00Z','2026-11-27T09:15:00Z'],'active evidence, rather than service date, orders the queue');
 assert.equal(guided.$q('[data-claim-waiting-count]').textContent,'1');
 guided.$q('[data-view-waiting-claims]').click();hasIds(guided,'claim',[65]);
 for(const [row,label,intent] of [
  [hold,'Fix 64405',{kind:'correction',procedure:'64405',line:0}],
  [zip,'Add ZIP code',{kind:'missing',field:'subscriber_address',part:'postal_code'}],
  [unconfirmed,'Check delivery',{kind:'delivery'}]
 ]){
  await guided.ctx.showClaimsWorkspace({filter:'action'});
  const button=`[data-claim-open="${row.id}"]`;
  assert.equal(guided.$q(button).textContent,label);
  await guided.click(button);
  assert.deepEqual(visits.at(-1),[row.id,row.account_id,intent]);
 }
 await guided.ctx.showClaimsWorkspace({filter:'action'});
 const remitPath=eraBase+'/'+matched.id;
 const remitLink=`[data-claim-worklist] [data-era-open="${matched.id}"]`;
 guided.routes.set(remitPath,()=>({remittance:{...matched,matches:[],document:{claims:[]}},postings:[],issues:[]}));
 await assert.rejects(guided.click(remitLink),/payment match changed/);
 guided.routes.set(remitPath,()=>({remittance:{...matched,document_hash:'synthetic-hash',matches:[{claim_id:paidRow.id,row_index:0,claim_version:2,account_version:2,writeoff_adjustments:[]}],document:{claims:[{control_number:paidRow.control_number,patient_name:'Synthetic Patient',paid_cents:2000,charged_cents:10000,patient_responsibility_cents:0,adjustments:[],services:[]}],total_paid_cents:2000,payment_date:'2026-11-27',payer_code:'SYN',currency:'USD'}},postings:[],issues:[]}));
 await guided.click(remitLink);
 assert.equal(guided.ctx.eraCurrent.id,matched.id);
 assert.equal(guided.ctx.document.activeElement.dataset.row,'0');
 assert(guided.calls.every(([,method])=>method==='GET'),'the worklist opens decisions without carrying them out');
 console.log('PASS exact worklist actions, evidence age, and matched payment focus');

 const recovery={claim_id:id(66),account_id:id(266),encounter_id:id(466),version:4,account_version:9};
 const corrected=claim(66,'void',{version:4,visit_id:recovery.encounter_id,snapshot:{account:{content:{visit_id:recovery.encounter_id}}},canceled_claim_recovery:recovery});
 const older=claim(67,'void',{version:3,visit_id:recovery.encounter_id,account_id:recovery.account_id,snapshot:corrected.snapshot});
 const canceled=fixture({claimRows:[older,corrected]});
 canceled.ctx.visitResubmitFromWorklist=async data=>canceled.opened.push(['resubmit',JSON.parse(JSON.stringify(data))]);
 await canceled.ctx.showClaimsWorkspace();
 assert.equal(canceled.stageCounts().action,1);
 assert.equal(canceled.stageCounts().send,0,'a canceled claim is not a draft ready for delivery');
 hasIds(canceled,'claim',[66]);
 const resubmit=`[data-claim-open="${corrected.id}"]`;
 assert.equal(canceled.$q(resubmit).textContent,'Resubmit claim');
 assert.match(canceled.$q(resubmit).closest('tr').textContent,/Canceled before sending/);
 const inactive=`[data-claim-open="${older.id}"]`;
 canceled.choose('void');
 assert.equal(canceled.$q(inactive).textContent,'Review cancellation');
 assert.equal(canceled.$q(inactive).hasAttribute('data-claim-visit'),false,'older void opens history directly');
 await canceled.click(inactive);
 assert.deepEqual(canceled.opened,[]);
 assert.equal(canceled.ctx.claimCurrent.id,older.id);
 assert.match(canceled.ctx.claimPrimaryActionMarkup(corrected,{canceled_claim_recovery:recovery}),/data-claim-intent="resubmit"[^>]*>Resubmit claim/);
 assert.doesNotMatch(canceled.ctx.claimPrimaryActionMarkup(older,{tracking:{submissions:[{status:'prepared',id:id(300)}]}}),/Resubmit claim|data-claim-existing-submission/);
 await canceled.click(resubmit);
 assert.deepEqual(canceled.opened,[['chart'],[corrected.patient_id,recovery.encounter_id],['resubmit',recovery]]);
 canceled.opened.length=0;
 const changed={...recovery,account_version:10};
 canceled.routes.set(claimsBase+'/'+corrected.id,()=>({claim:corrected,canceled_claim_recovery:changed}));
 await assert.rejects(canceled.click(resubmit),/posted charges changed/);
 assert.deepEqual(canceled.opened,[],'a stale recovery link cannot open or prepare a different account version');
 assert(canceled.calls.every(([,method])=>method==='GET'));
 console.log('PASS canceled recovery opens the exact corrected encounter while older voids stay in history');

 const coverageRow={account_id:id(201),account_version:5,patient_id:id(101),patient_name:'Synthetic Patient',visit_id:id(401),
  encounter_number:12,service_date:'2026-11-19',total_cents:47500,patient_paid_cents:2500,patient_owes_now_cents:45000,
  choices:[{id:id(75),payer_name:'Synthetic Primary Payer'}],state:'apply_coverage'};
 const blockedCoverage={...coverageRow,account_id:id(202),visit_id:id(402),encounter_number:13,
  blocker_code:'pending_payment',blocked_reason:'Resolve the pending card payment before applying insurance.'};
 const preparedCoverage={...coverageRow,account_id:id(203),visit_id:id(403),encounter_number:14,state:'prepare_claim',patient_owes_now_cents:0};
 const coverage=fixture({claimRows:[claim(1,'draft')],remittanceRows:[],history:true});
 const queueResult={can_apply_coverage:true,can_prepare_claim:true};
 coverage.routes.set(coverageBase,()=>({...queueResult,items:[coverageRow],next_cursor:'next coverage'}));
 coverage.routes.set(coverageBase+'?after=next%20coverage',()=>({items:[blockedCoverage,preparedCoverage]}));
 coverage.ctx.workspace={};
 let latestAccountVersion=5;
 coverage.ctx.selectPatient=async (patient,visit,current)=>{
  if(!current())return;
  coverage.opened.push([patient,visit]);
  coverage.ctx.selected=patient;coverage.ctx.activeVisit={id:visit};
  coverage.ctx.chartSection='visits';coverage.ctx.encounterSection='charges';
  coverage.$('clinical-workspace').hidden=false;coverage.$('tools').hidden=true;
  const row=[coverageRow,blockedCoverage,preparedCoverage].find(item=>item.visit_id===visit);
  coverage.ctx.workspace={billing:{accounts:[{id:row.account_id,version:latestAccountVersion,status:'posted',content:{visit_id:visit}}]}};
 };
 coverage.ctx.openEncounterCoverageWorklistAction=async (...args)=>coverage.opened.push(args);
 coverage.ctx.invoiceTabSet=tab=>coverage.opened.push([tab]);
 await coverage.ctx.showClaimsWorkspace();
 assert.equal(coverage.stageCounts().action,4);
 assert.equal(coverage.stageCounts().send,1,'a charge account does not count as a claim awaiting send');
 const apply=`[data-coverage-worklist-account="${coverageRow.account_id}"]`;
 const blocked=`[data-coverage-worklist-account="${blockedCoverage.account_id}"]`;
 const prepare=`[data-coverage-worklist-account="${preparedCoverage.account_id}"]`;
 const amountCells=selector=>Array.from(coverage.$q(selector).closest('tr').querySelectorAll('dl div'),item=>[item.querySelector('dt').textContent,item.querySelector('dd').textContent]);
 assert.deepEqual(amountCells(apply),[['Posted charges','$475.00'],['Patient paid','$25.00'],['Patient owes now','$450.00']]);
 assert.deepEqual(amountCells(prepare),[['Posted charges','$475.00'],['Patient paid','$25.00'],['Patient owes now','$0.00']]);
 assert.match(coverage.$q(apply).closest('tr').textContent,/ENC-0012 · Nov 19, 2026/);
 assert.equal(coverage.$q(apply).textContent,'Apply insurance');
 assert.equal(coverage.$q(blocked).textContent,'Review payments');
 assert.match(coverage.$q(blocked).closest('tr').textContent,/Resolve the pending card payment/);
 assert.equal(coverage.$q(prepare).textContent,'Prepare claim');
 coverage.stage('send').click();assert.equal(coverage.$q('[data-coverage-worklist]').hidden,true);
 coverage.stage('action').click();assert.equal(coverage.$q('[data-coverage-worklist]').hidden,false);
 await coverage.click(apply);
 assert.deepEqual(coverage.opened.splice(0),[[coverageRow.patient_id,coverageRow.visit_id],['charges'],[coverageRow.account_id,'apply_coverage',coverageRow.account_version]]);
 assert.equal(coverage.ctx.location.hash,`#/patients/${coverageRow.patient_id}/encounter/${coverageRow.visit_id}/charges`);
 coverage.ctx.history.back();
 await waitFor(()=>coverage.ctx.location.hash==='#/claims'&&!coverage.$('tools').hidden&&coverage.stage('action').getAttribute('aria-pressed')==='true');
 await new Promise(resolve=>coverage.ctx.requestAnimationFrame(()=>coverage.ctx.requestAnimationFrame(resolve)));
 await coverage.click(blocked);
 assert.deepEqual(coverage.opened.splice(0),[[blockedCoverage.patient_id,blockedCoverage.visit_id],['charges'],['payments']]);
 await coverage.ctx.showClaimsWorkspace({filter:'action'});
 await coverage.click(prepare);
 assert.deepEqual(coverage.opened.splice(0),[[preparedCoverage.patient_id,preparedCoverage.visit_id],['charges'],[preparedCoverage.account_id,'prepare_claim',preparedCoverage.account_version]]);
 coverage.routes.set(coverageBase+'?after=next%20coverage',()=>({items:[blockedCoverage]}));
 coverage.ctx.history.back();
 await waitFor(()=>coverage.ctx.location.hash==='#/claims'&&!coverage.$('tools').hidden&&!coverage.$q(prepare));
 await new Promise(resolve=>coverage.ctx.requestAnimationFrame(()=>coverage.ctx.requestAnimationFrame(resolve)));
 latestAccountVersion++;
 await assert.rejects(coverage.click(apply),/posted charges changed/);
 assert(!coverage.opened.some(([,action])=>action==='apply_coverage'),'a stale account can never launch an apply or prepare action');
 assert(coverage.calls.every(([,method])=>method==='GET'),'row actions hand off to the encounter and do not submit claims');
 coverage.routes.set(coverageBase,()=>{throw new Error('Service unavailable');});
 await coverage.ctx.showClaimsWorkspace({filter:'action'});
 assert.match(coverage.$q('[data-coverage-worklist]').textContent,/Could not check for insurance added after posting/);
 assert.equal(coverage.stageCounts().action,1);hasIds(coverage,'claim',[1]);
 coverage.routes.set(coverageBase,()=>({items:[coverageRow],can_apply_coverage:true,can_prepare_claim:false}));
 await coverage.click('[data-refresh-coverage-worklist]');
 assert.equal(coverage.$q(apply).textContent,'Review encounter');
 assert.equal(coverage.stageCounts().action,2);
 coverage.ctx.workspaceResourceAllowed=resource=>resource!=='clinical';
 await coverage.ctx.claimsAutoRefreshLoad();
 assert.equal(coverage.$q(apply),null,'view-only chart restrictions apply to queue navigation');
 const slowCoverage=fixture({claimRows:[claim(1,'draft')],remittanceRows:[]});
 let resolveCoverage;
 slowCoverage.routes.set(coverageBase,()=>new Promise(resolve=>{resolveCoverage=resolve;}));
 await slowCoverage.ctx.showClaimsWorkspace();
 hasIds(slowCoverage,'claim',[1]);
 assert.match(slowCoverage.$q('[data-coverage-worklist]').textContent,/Checking posted charges/);
 resolveCoverage({items:[coverageRow],...queueResult});
 await waitFor(()=>slowCoverage.$q(apply));
 assert.equal(slowCoverage.$q(apply).textContent,'Apply insurance');
 console.log('PASS coverage worklist totals, granular actions, retry, access and independent loading');

 const refresh=fixture();
 refresh.setRemittances([payment(30,'staged')],'older',[payment(36,'posted')]);
 await refresh.ctx.showClaimsWorkspace({filter:'posted'});
 await refresh.click('[data-era-next]');
 const detail=refresh.$('claims-detail');
 detail.innerHTML='<form id="claim-editor-form"><textarea>Unsaved correction</textarea></form>';
 const editor=detail.querySelector('form'),data=detail.querySelector('textarea');
 refresh.setRemittances([payment(30,'posted')],'older',[payment(36,'posted')]);
 refresh.setClaims([claim(45,'submitted',{claimmd_position:{needs_correction:true}})]);
 const from=refresh.paths().length;
 await refresh.ctx.claimsAutoRefreshLoad();
 assert.deepEqual(refresh.paths().slice(from),[claimsBase,eraBase,coverageBase,eraBase+'?after=older']);
 hasIds(refresh,'era',[30,36]);assert.equal(refresh.stageCounts().fix,1);
 assert.equal(refresh.$('claims-detail'),detail);assert.equal(detail.querySelector('form'),editor);
 assert.equal(data.value,'Unsaved correction');
 let resolveStale;
 refresh.routes.set(eraBase,()=>new Promise(resolve=>{resolveStale=resolve;}));
 const staleRefresh=refresh.ctx.claimsAutoRefreshLoad();
 refresh.ctx.me={user_id:'new-staff',tenant_id:'another-tenant',role:'owner'};
 refresh.routes.delete(eraBase);
 refresh.setClaims([claim(50,'draft')]);
 refresh.setRemittances([payment(51,'staged')],'tenant-owned-cursor',[payment(52,'staged')]);
 await refresh.ctx.showClaimsWorkspace();
 resolveStale({items:[payment(99,'posted')],next_cursor:null});
 await staleRefresh;
 assert.equal(refresh.stage('action').getAttribute('aria-pressed'),'true');
 hasIds(refresh,'claim',[50]);assert.equal(refresh.stageCounts().posted,0);
 assert.equal(refresh.stageCounts()['remittance-review'],1);
 console.log('PASS quiet refresh preserves details, loaded pages, and session isolation');

 for(const item of [f,empty,actions,readOnly,visit,guided,canceled,coverage,slowCoverage,refresh])item.dom.window.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
