// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
const claimsBase='/api/v1/billing/claims';
const eraBase='/api/v1/billing/remittances';
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
  money:value=>`$${(value/100).toFixed(2)}`,human:String,notice(){},billingWrite:()=>write,
  billingPayers:[],payerName:()=> 'Synthetic Payer',billingField:()=> '<input name="reason">',
  showTool:()=>$('nav-claims').setAttribute('aria-current','page'),captureVisitDrafts(){},busy:false,
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
   if(path==='/api/v1/billing/payers')return {items:[]};
   if(path==='/api/v1/billing/remittance-sources')return {items:[{source_history_id:id(40),source_id:'Synthetic import',source_instance:'Archive'}]};
   if(path.startsWith(claimsBase+'/')){
    if(path.endsWith('/history'))return {items:[]};
    const key=path.slice(claimsBase.length+1),row=[...pageClaims,...afterClaims].find(c=>c.id===key);
    assert.ok(row,`Fixture claim ${key} must exist`);
    return {claim:row,tracking:{remittance_posted:row.remittance_posted===true}};
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
 for(const file of ['display-format.js','visit-billing.js','claims.js'])vm.runInContext(fs.readFileSync('web/'+file,'utf8'),ctx);
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
 assert.deepEqual(f.stageCounts(),{send:2,wait:2,fix:3,'remittance-review':2,posted:1});
 assert.deepEqual(Array.from(f.ctx.document.querySelectorAll('[data-claim-status]'),button=>button.firstChild.textContent.trim()),
  ['To send','Waiting','Needs correction','Remittance to review','Posted']);
 assert.equal(f.stage('send').getAttribute('aria-pressed'),'true');
 assert.equal(f.$('nav-claims').getAttribute('aria-current'),'page');
 assert.ok(f.paths().includes(claimsBase+'?after=claims%20cursor'));
 assert.ok(!f.paths().includes(claimsBase+'/status-counts'));
 assert.ok(!f.paths().some(path=>path.startsWith(claimsBase+'/')),'worklist payment state comes from the list response');
 hasIds(f,'claim',[1,2]);hasIds(f,'era',[]);
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
 assert.deepEqual(f.stageCounts(),{send:2,wait:2,fix:3,'remittance-review':3,posted:2});
 hasIds(f,'era',[32,36]);assert.equal(f.$q('[data-era-more]').hidden,true);
 assert.deepEqual(f.panels,['automation','recoupments','batch']);
 assert.ok(f.$q('[data-era-source]'));assert.ok(f.$q('[data-payment-settings]'));
 await f.ctx.showClaimsWorkspace({filter:'send'});hasIds(f,'claim',[1,2]);
 await f.ctx.showClaimsWorkspace({filter:'payments'});hasIds(f,'era',[30,31,32,33,34,35,36,37]);
 console.log('PASS five stages, precise counts and states, shortcuts, older remittances, and legacy management');

 const empty=fixture({claimRows:[],remittanceRows:[payment(35,'unrecognized')]});
 empty.setRemittances([payment(35,'unrecognized')],'next',[payment(32,'posted')]);
 await empty.ctx.showClaimsWorkspace();
 assert.deepEqual(empty.stageCounts(),{send:0,wait:0,fix:0,'remittance-review':0,posted:0});
 assert.match(empty.$q('[data-claim-worklist]').textContent,/No claims to send/);
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
 assert.deepEqual(refresh.paths().slice(from),[claimsBase,eraBase,eraBase+'?after=older']);
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
 assert.equal(refresh.stage('send').getAttribute('aria-pressed'),'true');
 hasIds(refresh,'claim',[50]);assert.equal(refresh.stageCounts().posted,0);
 assert.equal(refresh.stageCounts()['remittance-review'],1);
 console.log('PASS quiet refresh preserves details, loaded pages, and session isolation');

 for(const item of [f,empty,actions,readOnly,visit,refresh])item.dom.window.close();
})().catch(error=>{console.error(error);process.exitCode=1;});
