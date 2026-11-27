// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}
const {visitSummary}=require('./visit_billing_fixture.cjs');
// A cancelled claim first prepares a new draft. Exercise the action with a synthetic encounter
// and recording API, including attempts to reuse a stale or unauthorized action.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers={},nodes={},sent=[],log=[];
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},hidden:false,scrollIntoView(){},querySelectorAll(){return [];},querySelector(){return null;},replaceChildren(){this.innerHTML='';},append(){}};
const account={id:'account',version:2,status:'posted',patient_id:'patient',total_cents:28000,coverage_snapshot:{payer:{content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}},coverage:{content:{member_id:'SYN-MEMBER'}}},content:{visit_id:'visit',service_date:'2026-11-12',coverage_id:'coverage',lines:[],notes:''}};
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,crypto:{randomUUID:()=>'request'},setTimeout:()=>0,clearTimeout(){},
 document:{addEventListener:(n,fn)=>(handlers[n]??=[]).push(fn),createElement:()=>({setAttribute(){}})},$:node,me:{role:'owner'},selected:'patient',chartSection:'visits',encounterSection:'charges',
 activeVisit:{id:'visit',appointment_id:'appointment',status:'signed',version:3},
 workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{}},appointments:[],visits:[{id:'visit'}],billing:{accounts:[account],coverages:[],entries:[],copays:[]}},
 esc,human:v=>String(v).replaceAll('_',' '),date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,dollars:v=>(v/100).toFixed(2),payerName:()=>'Synthetic Medicare PPO',billingCan:()=>true,
 showChartSection(){},setEncounterSection(){},notice:m=>{ctx.noticed=m;},run:fn=>{if(ctx.pending)return;ctx.pending=fn().catch(e=>{ctx.failed=e.stack||String(e);}).finally(()=>{ctx.pending=null;});return ctx.pending;},
 api:async(url,method='GET',body)=>{sent.push([url,method,body]);return {outcome:'prepared',claim_id:'replacement',issues:[]};}};
vm.createContext(ctx);
for(const f of ['visit-billing.js','patient-revenue.js','visit-review.js'])vm.runInContext(fs.readFileSync('web/'+f,'utf8'),ctx);
const fresh=visitSummary({state:'send_claim',claim:{id:'replacement',status:'ready',issues:[]}});
const canceled=visitSummary({state:'claim_cancelled',claim:null,canceled_claim:{id:'cancelled-original',version:4}});
const state=vm.runInContext('encounterRevenueState',ctx);
const show=(summary=canceled)=>{state.data={summary};};
const prepareResult=ctx.api;
let reload=fresh;
ctx.loadEncounterRevenueStatus=async(account,force,options)=>{log.push(['reload',account.id,force,options?.prepare]);show(reload);};
ctx.visitReviewRun=async()=>{throw new Error('Resubmit must not send');};
ctx.visitReviewOpen=()=>{throw new Error('Resubmit must open the exact draft');};
ctx.visitOpenSignedClaimDetails=()=>log.push(['review',state.data.summary.claim.id]);
const dataset={visitClaimResend:'cancelled-original',canceledClaimVersion:'4'};
const click=(fields=dataset)=>{const button={dataset:fields,disabled:false,isConnected:true,textContent:'Resubmit claim',hasAttribute:n=>n.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()) in fields,closest:()=>null};for(const h of handlers.click||[])h({target:{closest:s=>s==='button'?button:null},preventDefault(){}});return button;};
const all={canCreate:true,canWrite:true,claimsAllowed:true,canResubmitClaim:true};
const draw=(s=canceled,options={})=>ctx.visitBillingCardMarkup(s,{...all,...options});
const action=/data-visit-claim-resend="cancelled-original" data-canceled-claim-version="4" aria-haspopup="dialog">Resubmit claim/;
function reset(summary){sent.length=0;log.length=0;ctx.noticed=undefined;ctx.api=prepareResult;reload=fresh;show(summary);}

(async()=>{
 for(const delegated of [false,true]){
  const html=draw(canceled,{delegated});
  assert.match(html,/The claim to Synthetic Medicare PPO was cancelled/);
  assert.match(html,/Opens a new draft for review/);
  assert.match(html,action);
  assert.equal((html.match(/>Resubmit claim</g)||[]).length,1);
  const encounter=ctx.visitEncounterClaimStatus(canceled,{...all,delegated},false);
  assert.match(encounter,action);
  assert.doesNotMatch(encounter,/data-open-signed-claim-details/);
 }
 for(const denied of ['canCreate','claimsAllowed','canResubmitClaim'])assert.doesNotMatch(draw(canceled,{[denied]:false}),action);
 assert.match(draw(canceled,{canWrite:false}),action,'claims creation can prepare a draft independently of edit or send');
 const blocked=visitSummary({state:'claim_cancelled',claim:null,canceled_claim_blocked:'Verify the clearinghouse cancellation first.'});
 for(const html of [draw(blocked),ctx.visitEncounterClaimStatus(blocked,all,false)]){
  assert.match(html,/Verify the clearinghouse cancellation first/);
  assert.match(html,/data-refresh-revenue>Check claim status/);
  assert.doesNotMatch(html,action);
  assert.doesNotMatch(html,/Nothing is with the insurer/);
 }
 const blockedWithHistory={...blocked,canceled_claim_status_id:'cancelled-original'};
 const history=ctx.visitEncounterClaimStatus(blockedWithHistory,all,false);
 assert.match(history,/data-revenue-claim="cancelled-original">Check claim status/);
 assert.doesNotMatch(history,/data-refresh-revenue/);
 assert.doesNotMatch(ctx.visitEncounterClaimStatus(blockedWithHistory,{...all,claimsAllowed:false},false),/cancelled-original/);
 show();
 const button=click();
 assert.equal(button.disabled,true);assert.equal(button.textContent,'Preparing draft…');
 click();
 await ctx.pending;
 assert.equal(ctx.failed,undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(sent)),[['/api/v1/patients/patient/billing/accounts/account/claims/prepare','POST',
  {again:true,canceled_claim_id:'cancelled-original',canceled_claim_version:4,canceled_account_version:2}]]);
 assert.deepEqual(log,[['reload','account',true,false],['review','replacement']]);
 assert.equal(button.disabled,false);

 reset();ctx.me={role:'front_desk',delegated:true};ctx.workspaceResourceAllowed=(resource,action)=>resource!=='claims'||action==='view';
 click();await ctx.pending;
 assert.equal(sent.length,0,'view-only claims access never prepares a draft');
 ctx.workspaceResourceAllowed=()=>true;
 click({...dataset,canceledClaimVersion:'3'});await ctx.pending;
 assert.equal(sent.length,0,'a stale rendered button cannot submit a different version');
 click();await ctx.pending;
 assert.equal(sent.length,1,'a delegated billing actor with effective write access can resubmit');
 assert.deepEqual(log,[['reload','account',true,false],['review','replacement']]);

 reset();reload=visitSummary({state:'send_claim',claim:{id:'another-claim',status:'ready'}});
 click();await ctx.pending;
 assert.equal(sent.length,1);assert.deepEqual(log,[['reload','account',true,false]]);
 assert.match(ctx.noticed,/could not be confirmed/);

 reset();ctx.api=async()=>({outcome:'exists',claim_id:'replacement'});
 click();await ctx.pending;
 assert.deepEqual(log,[['reload','account',true,false],['review','replacement']]);

 reset();reload=blocked;ctx.api=async()=>{throw new Error('The cancelled claim changed.');};
 click();await ctx.pending;
 assert.deepEqual(log,[['reload','account',true,false]],'refreshes once after a conflict without opening or retrying');
 assert.equal(ctx.noticed,'The cancelled claim changed.');

 reset();
 let finish;
 ctx.api=async(...args)=>{await new Promise(resolve=>{finish=resolve;});return prepareResult(...args);};
 click();
 const previousVisit=ctx.activeVisit;ctx.activeVisit={...previousVisit,id:'another-visit'};
 finish();await ctx.pending;
 assert.equal(sent.length,1);assert.deepEqual(log,[],'do not refresh or open a draft after switching encounters');
 ctx.activeVisit=previousVisit;

 reset();
 const recovery={account_id:account.id,encounter_id:ctx.activeVisit.id,claim_id:dataset.visitClaimResend,version:4,account_version:account.version};
 const mountedButton={dataset,disabled:false,isConnected:true,textContent:'Resubmit claim'};
 node('visit-page-host').querySelector=()=>mountedButton;
 ctx.encounterStepsSync=()=>log.push(['mount']);
 ctx.setEncounterSection=step=>log.push([step]);
 let scopedReadCount=0;
 ctx.loadEncounterRevenueStatus=async(account,force,options)=>{log.push(['reload',account.id,force,options?.prepare]);show(scopedReadCount++?fresh:canceled);};
 await assert.rejects(ctx.visitResubmitFromWorklist({...recovery,account_version:1}),/posted charges or claim changed/);
 assert.deepEqual(log,[]);
 assert.equal(sent.length,0);
 await ctx.visitResubmitFromWorklist(recovery);
 assert.deepEqual(log,[['reload','account',true,false],['charges'],['mount'],['reload','account',true,false],['review','replacement']]);
 assert.equal(sent.length,1);
 assert.equal(sent[0][2].canceled_account_version,2);

 reset();
 ctx.loadEncounterRevenueStatus=async()=>show(blocked);
 await assert.rejects(ctx.visitResubmitFromWorklist(recovery),/Verify the clearinghouse cancellation first/);
 assert.equal(sent.length,0,'a changed claim is never prepared by a stale worklist selection');
 console.log('cancelled claim resend checks ok');
})().catch(e=>{console.error(e);process.exit(1);});
