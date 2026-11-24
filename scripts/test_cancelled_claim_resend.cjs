// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}
const {visitSummary}=require('./visit_billing_fixture.cjs');
// A cancelled claim goes out again in one press: prepare again, read the encounter back, then the
// review panel's own send when nothing needs fixing, or the review panel when something does.
// Synthetic DOM and a recording api; nothing talks to a server.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers={},nodes={},sent=[],log=[];
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},hidden:false,scrollIntoView(){},querySelectorAll(){return [];},querySelector(){return null;},replaceChildren(){this.innerHTML='';},append(){}};
const account={id:'account',version:2,status:'posted',patient_id:'patient',total_cents:28000,coverage_snapshot:{payer:{content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}},coverage:{content:{member_id:'SYN-MEMBER'}}},content:{visit_id:'visit',service_date:'2026-11-12',coverage_id:'coverage',lines:[],notes:''}};
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,crypto:{randomUUID:()=>'request'},setTimeout:()=>0,clearTimeout(){},
 document:{addEventListener:(n,fn)=>(handlers[n]??=[]).push(fn),createElement:()=>({setAttribute(){}})},$:node,me:{role:'owner'},selected:'patient',chartSection:'visits',encounterSection:'charges',
 activeVisit:{id:'visit',appointment_id:'appointment',status:'signed',version:3},
 workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{}},appointments:[],visits:[{id:'visit'}],billing:{accounts:[account],coverages:[],entries:[],copays:[]}},
 esc,human:v=>String(v).replaceAll('_',' '),date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,dollars:v=>(v/100).toFixed(2),payerName:()=>'Synthetic Medicare PPO',billingCan:()=>true,
 showChartSection(){},setEncounterSection(){},notice:m=>{ctx.noticed=m;},run:fn=>{ctx.pending=Promise.resolve().then(fn).catch(e=>{ctx.failed=e.stack||String(e);});return ctx.pending;},
 api:async(url,method='GET',body)=>{sent.push([url,method,body]);return {outcome:'prepared',claim_id:'claim',issues:[]};}};
vm.createContext(ctx);
for(const f of ['visit-billing.js','patient-revenue.js','visit-review.js'])vm.runInContext(fs.readFileSync('web/'+f,'utf8'),ctx);
const fresh=visitSummary({state:'send_claim',claim:{id:'claim',status:'ready',issues:[]}});
ctx.loadEncounterRevenueStatus=async()=>{log.push('reload');vm.runInContext('encounterRevenueState',ctx).data={summary:fresh};};
ctx.visitReviewChecks=()=>ctx.checks||[];
ctx.visitReviewRun=async(id,options)=>{log.push(['run',id,!!options]);return true;};
ctx.visitReviewOpen=()=>log.push('open');
const click=dataset=>{const button={dataset,disabled:false,isConnected:true,textContent:'',hasAttribute:n=>n.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()) in dataset,closest:()=>null};for(const h of handlers.click||[])h({target:{closest:s=>s==='button'?button:null},preventDefault(){}});return button;};
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
const cancelled=()=>visitSummary({state:'claim_cancelled',claim:null});
const card=(s,context)=>ctx.visitBillingCardMarkup(s,context);
const all={canCreate:true,canWrite:true,claimsAllowed:true};

(async()=>{
 // (a) the next step offers the one button
 const html=card(cancelled(),all);
 assert.match(html,/The claim to Synthetic Medicare PPO was cancelled/);
 assert.match(html,/Nothing is with the insurer/);
 assert.match(html,/<button type="button" class="primary" data-visit-claim-resend>Send the claim again</);
 // (d) no button without permission to create, and none for a support session
 assert.doesNotMatch(card(cancelled(),{...all,canCreate:false}),/data-visit-claim-resend/);
 assert.doesNotMatch(card(cancelled(),{...all,delegated:true}),/data-visit-claim-resend/);

 // (b) prepare again, reload, then the review panel's send when nothing must be fixed
 const button=click({visitClaimResend:''});
 assert.equal(button.disabled,true);assert.equal(button.textContent,'Sending…');
 await settle();
 assert.equal(ctx.failed,undefined);
 assert.equal(sent.length,1);assert.match(sent[0][0],/\/billing\/accounts\/account\/claims\/prepare$/);
 assert.equal(sent[0][1],'POST');assert.equal(JSON.stringify(sent[0][2]),'{"again":true}');
 assert.equal(JSON.stringify(log.filter(x=>x==='reload'||x[0]==='run')),JSON.stringify(['reload',['run','claim',true]]),'reloaded, then sent through the review chain');

 // (c) a must-fix item opens the review panel and sends nothing
 log.length=0;sent.length=0;ctx.checks=[{level:'must',text:'x'}];
 click({visitClaimResend:''});await settle();
 assert.equal(sent.length,1);
 assert.equal(JSON.stringify(log),JSON.stringify(['reload','open']),'the panel opens, no send');
 console.log('cancelled claim resend checks ok');
})().catch(e=>{console.error(e);process.exit(1);});
