// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}
const {visitSummary}=require('./visit_billing_fixture.cjs');
// The card's next step posts the charges itself: one plain ask, then exactly the request the
// lower form sends when its reason box is left as rendered. A payer with no electronic ID still
// has to tick the acknowledgement in that form, so the card's button only scrolls down to it.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers={},nodes={},sent=[],scrolled=[],opened=[];
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},hidden:false,open:false,scrollIntoView(){scrolled.push(id);},querySelector(){return null;},querySelectorAll(){return [];},replaceChildren(){this.innerHTML='';},append(){}};
const draftAccount=coverageId=>({id:'account',version:4,status:'draft',patient_id:'patient',total_cents:28000,content:{visit_id:'visit',service_date:'2026-11-12',coverage_id:coverageId,lines:[],notes:''}});
const coverage={id:'coverage',version:2,content:{payer_id:'payer',priority:'primary',status:'active',effective_date:'2026-01-01',end_date:null,member_id:'SYN-MEMBER',verification:'manually_verified'}};
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,crypto:{randomUUID:()=>'request'},setTimeout:()=>0,clearTimeout(){},
 me:{role:'front_desk'},selected:'patient',billingSelected:null,chartSection:'visits',encounterSection:'charges',
 activeVisit:{id:'visit',appointment_id:'appointment',status:'signed',version:3},
 workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{}},appointments:[{id:'appointment',starts_at:'2026-11-12T15:00:00Z',status:'in_progress'}],visits:[{id:'visit',appointment_id:'appointment',status:'signed'}],billing:{accounts:[draftAccount('coverage')],coverages:[coverage],entries:[],copays:[]}},
 billingPayers:[{id:'payer',content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}}],
 esc,human:v=>String(v).replaceAll('_',' '),date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,dollars:v=>(v/100).toFixed(2),cents:v=>Math.round(Number(v)*100),
 payerName:()=>'Synthetic Medicare PPO',billingCan:()=>true,showChartSection:key=>ctx.chartSection=key,setEncounterSection(){},showEncounterSection:key=>ctx.revealed=key,notice:message=>ctx.noticed=message,
 run:fn=>ctx.pending=Promise.resolve().then(fn).catch(error=>{ctx.failed=error.stack||String(error);}),
 selectPatient:async()=>{sent.push(['rerender']);},openBillingEditor(){},showBillingAccount:(id,activate)=>opened.push([id,activate]),
 $:node,document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),createElement:()=>({setAttribute(){}})},
 confirmAction:async(message,options)=>{ctx.asked=[message,options.title,options.confirmLabel];return ctx.answer;},
 api:async(...args)=>{sent.push(args);return String(args[0]).includes('/visit-summary')?postSummary():{};}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/visit-billing.js','utf8'),ctx);
const billing=fs.readFileSync('web/billing.js','utf8');
vm.runInContext(billing.slice(billing.indexOf('function encounterRevenueVisitUnsigned('),billing.indexOf('function billingEditorHost(')),ctx);
vm.runInContext('const billingBase=()=>"/api/v1/patients/"+selected+"/billing/accounts";',ctx);
vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
vm.runInContext('function setRevenueSummary(s){encounterRevenueState.data={summary:s};}',ctx);
const click=dataset=>{const button={dataset,disabled:false,hasAttribute:name=>name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()) in dataset,closest:()=>null};for(const handler of handlers.click)handler({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});return button;};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const posts=()=>sent.filter(call=>String(call[0]).endsWith('/actions'));
// Pressing the card's button, with the card showing a draft account still to be posted.
let postSummary=()=>visitSummary({state:'post_charges',waiting_on:'staff',account:{id:'account',status:'draft',version:4,total_cents:28000},charges_cents:28000,balance_cents:null,claim:null,insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:true,status:'not_billed',pending_cents:27000}});
const press=()=>{ctx.setRevenueSummary(postSummary());click({visitPostCharges:'account'});};
const card=()=>ctx.visitBillingCardMarkup(postSummary(),{canCreate:true,canWrite:true,claimsAllowed:true});
const reset=()=>{sent.length=0;opened.length=0;scrolled.length=0;ctx.asked=null;ctx.failed=null;ctx.noticed=null;};
const useAccount=coverageId=>{ctx.workspace.billing={...ctx.workspace.billing,accounts:[draftAccount(coverageId)],coverages:coverageId?[coverage]:[]};ctx.setRevenueSummary(postSummary());};
(async()=>{
 // The card's one action is the posting itself.
 const html=card();
 assert.match(html,/<button type="button" class="primary" data-visit-post-charges="account">Post charges<\/button>/,html.slice(0,700));
 assert.doesNotMatch(html,/Review and post charges/,'the card no longer sends staff on a scroll to a second form');
 // Confirming posts once, with exactly the body the lower form sends when its reason box is left empty.
 ctx.answer=true;reset();press();await settle();if(ctx.failed)throw new Error(ctx.failed);
 assert.deepEqual(ctx.asked,['Charges of $280.00 become final and the insurance claim is prepared.','Post these charges?','Post charges'],'one plain ask, and only before anything is sent');
 assert.deepEqual(posts().map(call=>[call[0],call[1],JSON.stringify(call[2]),call[3]]),[['/api/v1/patients/patient/billing/accounts/account/actions','POST','{"action":"post","reason":"Charges posted","local_only":false}',4]],'the lower form\'s endpoint, action, a default reason and version');
 const postedReason=posts()[0][2].reason;
 assert.equal(typeof postedReason,'string');assert.ok(postedReason.trim().length>0&&postedReason.length<=1000,'the post carries a non-empty reason of at most 1000 characters');
 assert.ok(sent.some(call=>call[0]==='rerender'),'the visit is reopened the way the lower form reopens it');
 assert.deepEqual(sent.at(-1),['/api/v1/patients/patient/billing/visit-summary?visit_id=visit'],'then the card reads what the server now says');
 assert.equal(ctx.revealed,'charges','the billing step is shown again after posting');
 assert.equal(opened.length,0,'a direct post never opens the lower form');assert.equal(scrolled.length,0);
 // Cancelling sends nothing and opens nothing.
 ctx.answer=false;reset();press();await settle();if(ctx.failed)throw new Error(ctx.failed);
 assert.equal(sent.length,0,'a cancelled ask writes nothing');assert.equal(opened.length,0);assert.equal(scrolled.length,0);
 // An unsigned visit note gives the card no way to post, so nothing is sent even by passing it.
 ctx.answer=true;ctx.activeVisit={...ctx.activeVisit,status:'in_progress'};ctx.workspace.visits=[{id:'visit',appointment_id:'appointment',status:'in_progress'}];
 reset();press();await settle();if(ctx.failed)throw new Error(ctx.failed);
 assert.equal(ctx.asked,null,'an unsigned note is not even asked about');assert.equal(sent.length,0);
 ctx.activeVisit={...ctx.activeVisit,status:'signed'};ctx.workspace.visits=[{id:'visit',appointment_id:'appointment',status:'signed'}];
 // A payer with no electronic ID: no ask and no post; the lower form is opened and scrolled to.
 ctx.billingPayers=[];reset();press();await settle();if(ctx.failed)throw new Error(ctx.failed);
 assert.equal(ctx.asked,null,'the acknowledgement in the lower form cannot be skipped by a dialog');
 assert.equal(sent.filter(call=>call[1]==='POST').length,0,'nothing is posted without that acknowledgement');
 assert.deepEqual(opened,[['account',false]]);assert.deepEqual(scrolled,['encounter-charge-details']);
 // Self-pay: the same post, and the ask says nothing about a claim.
 ctx.billingPayers=[{id:'payer',content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}}];
 useAccount(null);reset();press();await settle();if(ctx.failed)throw new Error(ctx.failed);
 assert.deepEqual(ctx.asked,['Charges of $280.00 become final.','Post these charges?','Post charges'],'no insurance, no claim sentence');
 assert.equal(JSON.stringify(posts()[0][2]),'{"action":"post","reason":"Charges posted","local_only":false}');
 console.log('PASS card posts charges in one step: one ask naming the amount, the lower form\'s exact request, cancel writes nothing, an unsigned note cannot post, a payer with no electronic ID still goes to the form');
})().catch(error=>{console.error(error);process.exitCode=1;});
