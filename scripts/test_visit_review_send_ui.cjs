// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}
const {visitSummary}=require('./visit_billing_fixture.cjs');

// The review-and-send panel: the checks it shows and how it classifies them, the one button
// that runs post → prepare → ready → the native review form, a failure stopping the chain,
// and continuing with an unsigned note only after the tick. Every API call is recorded; nothing
// here talks to a real server and every value is synthetic.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nodes={},handlers={},sent=[];
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},hidden:false,open:false,scrollIntoView(){},querySelector(sel){return (this._q??={})[sel]??null;},querySelectorAll(){return [];},replaceChildren(){this.innerHTML='';},insertAdjacentHTML(){},focus(){},};
const accountOf=(overrides={})=>({id:'account',patient_id:'patient',version:4,status:'posted',total_cents:28000,content:{visit_id:'visit',service_date:'2026-11-12',lines:[{code:'99213',description:'Office visit',units:1,amount_cents:28000,diagnosis_codes:['M62.81']}]},coverage_snapshot:{coverage:{content:{relationship:'self',member_id:'SYN-MEMBER'}},payer:{content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}}},...overrides});
let account=accountOf();
// The screen finds the encounter's charge account through workspace.billing.accounts, exactly as
// encounterChargeAccount does. Keeping that array in step with the fixture is the whole bridge.
function setAccount(next){account=next;vmAccount();return account;}
function vmAccount(){ctx.workspace.billing={...ctx.workspace.billing,accounts:[account]};}
// A claim filled in and holding everything: what the checks see is what a prepared claim carries.
const filled=()=>({billing_provider_name:'Synthetic Care Group',billing_address:'1 Synthetic Way',tax_id:'123456789',billing_npi:'1234567890',rendering_npi:'0987654321',billing_taxonomy:'207R00000X',patient_address:'1 Synthetic Way',subscriber_address:'1 Synthetic Way',subscriber_birth_date:'1980-01-01',place_of_service:'11',diagnosis_codes:['M62.81'],line_diagnosis_pointers:[[1]]});
const claimOf=(overrides={})=>({id:'claim',patient_id:'patient',account_id:'account',version:2,status:'draft',snapshot:{account:account,patient:{given_name:'Synthetic',family_name:'Patient'}},...overrides});
// A claim as it sits after being filled in: the form the review reads is on the claim itself.
const claimFilled=()=>claimOf({content:filled()});
let claim=claimFilled();
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,setTimeout:()=>0,clearTimeout(){},crypto:{randomUUID:()=>`req-${sent.length}`},
 me:{role:'owner'},selected:'patient',billingSelected:null,chartSection:'visits',encounterSection:'charges',
 activeVisit:{id:'visit',appointment_id:'appointment',status:'signed',version:3},
 workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{address:{line1:'1 Synthetic Way',city:'Synthetic City',region:'SY',postal_code:'00000',country:'US'}}},appointments:[{id:'appointment',status:'in_progress'}],visits:[{id:'visit',appointment_id:'appointment',status:'signed'}],billing:{accounts:[account],coverages:[{id:'synthetic-coverage',content:{status:'active',effective_date:'2020-01-01',priority:'primary',payer_id:'synthetic-payer',relationship:'self',member_id:'SYN-MEMBER'}}],entries:[],copays:[]}},
 $:node,document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),createElement:()=>({setAttribute(){}})},
 // The panel and the card reach for these the way the live page has them; the billing scripts
 // that own them are not loaded here, so the ones the review module touches are stubbed.
 captureClaimDraft(){},openEncounterCharges(){ctx.chargesOpened=(ctx.chargesOpened||0)+1;},
 esc,human:v=>String(v).replaceAll('_',' '),date:v=>v,money:v=>`$${(v/100).toFixed(2)}`,dollars:v=>(v/100).toFixed(2),cents:v=>Math.round(Number(v)*100),
 billingPayers:[{id:'synthetic-payer',content:{name:'Synthetic Medicare PPO',payer_code:'SYN'}}],
 payerName:()=>'Synthetic Medicare PPO',billingCan:()=>true,workspaceResourceAllowed:()=>true,claimsApiBase:'/api/v1/billing/claims',
 notice:m=>{ctx.noticed=m;},run:fn=>{ctx.pending=Promise.resolve().then(fn).catch(e=>{ctx.failed=e.stack||String(e);});return ctx.pending;},
 confirmAction:async()=>true,
 showChartSection(){},setEncounterSection:k=>{ctx.encounterSection=k;},showTool(){},
 encounterRevenueVisitUnsigned:()=>ctx.unsigned===true,
 claimMdConnectionState:{connected:true},loadClaimMdConnection:async()=>{ctx.connectionLoads=(ctx.connectionLoads||0)+1;},
 // The practice's own billing setup, as the Claim.MD provider defaults hold it in the live page.
 claimmdClaimProviderDefaults:()=>({billing_provider_name:'Synthetic Care Group',billing_address:'1 Synthetic Way',billing_npi:'1234567890',rendering_npi:'0987654321',tax_id:'123456789'}),
 claimHasRecordedSubmission:()=>false,claimHasPreparedSubmission:()=>false,
 showEncounterClaim:async()=>{},claimEditor(){},captureClaimDraft(){},openEncounterCharges(){ctx.chargesOpened=(ctx.chargesOpened||0)+1;},
 api:async(path,method='GET',body,version)=>{
   sent.push({path,method,body:body?JSON.parse(JSON.stringify(body)):null,version});
   if(path.endsWith('/actions')&&method==='POST'){if(body&&body.action==='post'){setAccount({...account,status:'posted',version:account.version+1});return account;}if(ctx.failAt==='ready')throw new Error('The claim changed since you opened it');claim={...claim,status:'ready',version:claim.version+1};return claim;}
   if(/\/claims\/claim$/.test(path))return {claim,preflight_issues:ctx.preflight||[],transport:{routes:[{provider:'claim_md',route_key:'claimmd'}]}};
   if(path.endsWith('/claims/prepare'))return {outcome:'prepared',claim_id:'claim',issues:[]};
   if(path.endsWith('/visit-summary'))return reviewSummary();
   throw new Error('Unexpected API '+path);
 },
 async openEncounterClaimMdSubmit(id,accountId){
  if(ctx.failAt==='native-review')throw new Error('Synthetic native review failure');
  const fresh=await ctx.api('/api/v1/billing/claims/'+id);
  assert.equal(fresh.claim.status,'ready');
  ctx.nativeReview={id,accountId,version:fresh.claim.version};
  return true;
 }};
vm.createContext(ctx);
vm.runInContext('const billingBase=()=>"/api/v1/patients/"+selected+"/billing/accounts";',ctx);
vm.runInContext(fs.readFileSync('web/visit-billing.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
vm.runInContext(fs.readFileSync('web/visit-review.js','utf8'),ctx);
vm.runInContext('encounterRevenueState.review=null;',ctx);
const reviewState=()=>vm.runInContext('encounterRevenueState',ctx);
const review=(summary)=>vm.runInContext('visitReviewChecks',ctx)(summary,vm.runInContext('visitReviewContext',ctx)());
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
const click=(dataset,{disabled=false}={})=>{
 const attribute=`data-${Object.keys(dataset)[0]||''}`;
 const button={dataset,disabled,hasAttribute:name=>name===attribute,closest:()=>null};
 for(const handler of handlers.click)handler({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});
 return button;};
 // The summary's money lines come from the account in hand, the way /visit-summary fills them.
const runChain=(claimId,options={})=>vm.runInContext('visitReviewRun',ctx)(claimId,{confirmPost:true,...options});
// A post from the panel is the same call the lower form makes; without it the chain posts nothing.
// The state the encounter is in before anything has been posted or prepared; visit-summary gives
// it no claim yet, and the practice's own details come from its billing setup, not a claim.
const postSummary=()=>{const s=visitSummary({state:'post_charges',waiting_on:'staff',account:{id:'account',status:'draft',version:4,total_cents:28000},charges_cents:28000,balance_cents:null,claim:null,insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:true,status:'not_billed',pending_cents:27000},patient:{copay_cents:1000,owes_now_cents:0}});return {...s,claim:null};};
function reviewSummary(overrides={}){
 // The summary the server gives once the claim is filled in: it carries the claim's own copy
 // of what the form holds, exactly as /visit-summary does.
 const base={state:'send_claim',waiting_on:'staff',account:{id:'account',status:account.status,version:account.version,total_cents:account.total_cents},
  charges_cents:28000,balance_cents:27000,
  insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:true,status:'not_billed',pending_cents:27000},
  patient:{copay_cents:1000,owes_now_cents:0}};
 const over=typeof overrides==='object'&&overrides?overrides:{};
 const merged={...base,...over};
 merged.claim=over.claim===undefined?{id:claim.id,status:claim.status,version:claim.version,content:claim.content}:over.claim;
 return visitSummary(merged);
}
const showOnScreen=summary=>{reviewState().data={summary};reviewState().reviewCard=summary;};
const panelHost=()=>node('visit-billing-review');
const assertMustFixFooter=()=>{
 const count=review(reviewState().data.summary).filter(check=>check.level==='must').length;
 assert.ok(count>0,'the fixture has must-fix problems');
 const footer=panelHost().innerHTML.match(/<footer\b[^>]*>[\s\S]*?<\/footer>/)?.[0];
 assert.ok(footer,'the review footer is present');
 const button=footer.match(/<button\b[^>]*\bdata-visit-review-send\b[^>]*>/)?.[0];
 assert.ok(button,'the send button stays present with must-fix problems');
 assert.match(button,/\sdisabled(?:\s|=|>)/,'the send button is disabled with must-fix problems');
 assert.match(footer,new RegExp(`data-claim-problems>${count} thing${count===1?'':'s'} to fix<`),'the footer shows the number of things to fix');
};
const openPanel=(summary,ctxArgs={})=>{showOnScreen(summary);vm.runInContext('visitReviewOpen',ctx)(ctxArgs);};
const reset=()=>{vmAccount();sent.length=0;ctx.failed=null;ctx.noticed=null;ctx.failAt=null;ctx.preflight=null;ctx.nativeReview=null;setAccount(accountOf());claim=claimFilled();ctx.unsigned=false;ctx.activeVisit.status='signed';};
(async()=>{
 // ---- Classification: what must be put right, what is only worth a look ----
 claim={...claim,status:'ready'};
 let checks=review(reviewSummary());
 const keys=checks.map(c=>c.key);
 assert.equal(keys.length,1,'a clean ready claim says there is nothing to check');
 assert.equal(keys[0],'all-clear','and what it says is there is nothing to check');
 claim={...claim,status:'draft'};
 checks=review(reviewSummary({claim:{id:claim.id,status:'draft',version:2,issues:[{code:'tax_id',missing:'billing organization tax ID',detail:'Tax ID is required'}]}}));
 assert.ok(checks.some(c=>c.level==='must'&&/tax id/i.test(c.text)),'a missing tax ID is a must fix');
 setAccount(accountOf({status:'draft'}));
 checks=review(postSummary());
 assert.ok(checks.some(c=>/no diagnosis|not.*posted|post/i.test(c.text))||checks.every(c=>c.level==='must'),'the unposted charge lines are answered before the send');
 setAccount(accountOf());
 ctx.unsigned=true;ctx.activeVisit.status='in_progress';
 checks=review(reviewSummary());
 const note=checks.find(c=>c.key==='note-unsigned');
 assert.ok(note,'the unsigned note is listed');
 assert.equal(note.level,'must','the note must be signed before claim sending');
 assert.equal(note.action,'Sign the note','and it carries the way to put it right');
 ctx.unsigned=false;ctx.activeVisit.status='signed';
 checks=review(reviewSummary({insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:false,status:'not_billed',pending_cents:27000}}));
 assert.ok(checks.some(c=>c.level==='must'&&c.group==='insurance'&&/insurer id/i.test(c.text)),'a payer with no electronic ID stops the send, in the insurance group');
 const missingSetup=reviewSummary({insurance:{insured:true,insurer:'Synthetic Medicare PPO',electronic:false},claim:{id:claim.id,status:'draft',content:{...filled(),rendering_npi:'',billing_npi:''},issues:[{code:'payer_code',missing:'payer ID'}]}});
 const separate=review(missingSetup);
 assert.equal(separate.filter(row=>row.key==='payer-code').length,1,'one payer ID correction');
 assert.equal(separate.find(row=>row.key==='practice-rendering_npi')?.attribute,'data-practice-providers');
 assert.equal(separate.find(row=>row.key==='practice-billing_npi')?.attribute,'data-billing-organizations');
 assert.ok(!separate.some(row=>['practice-name','practice-address','insurance-subscriber_birth_date'].includes(row.key)));
 checks=review(reviewSummary({insurance:{insured:false,insurer:null,electronic:false,status:'not_billed',pending_cents:0}}));
 assert.equal(checks.length,1);assert.equal(checks[0].level,'note','self-pay says so and stops, it does not block a send that cannot happen');
 assert.ok(/no insurance/i.test(checks[0].text));
 const listed=checks.concat(review(reviewSummary({claim:{id:'claim',status:'draft',version:2,secondary:true}})));
 assert.ok(listed.some(c=>c.key==='secondary-claim'&&c.level==='must'),'a crossover claim belongs to the primary, and says so');

 // In a draft, show the subscriber and payer for the coverage selected on the charge account.
 const primary=ctx.workspace.billing.coverages[0];
 const secondary={id:'secondary',content:{...primary.content,priority:'secondary',relationship:'child',payer_id:'secondary-payer',member_id:'DEPENDENT'}};
 const heldProviders=ctx.claimmdClaimProviderDefaults;
 const heldSubscriber=ctx.claimmdSubscriberBirthMissing;
 const directoryHelpers=vm.runInNewContext(fs.readFileSync('web/claimmd-eligibility.js','utf8')+'\n({claimmdSubscriberBirthMissing,claimmdClaimProviderDefaults})',{document:{addEventListener(){}}});
 Object.assign(ctx,directoryHelpers);
 ctx.activeVisit.status='in_progress';ctx.activeVisit.clinician_id='assigned';ctx.workspace.patient.birth_date='1980-02-01';
 ctx.workspace.billing.coverages.push(secondary);ctx.billingPayers.push({id:'secondary-payer',content:{name:'Secondary insurance',payer_code:'SECONDARY'}});
 const draft=accountOf({status:'draft'});
 draft.content={...draft.content,coverage_id:secondary.id,lines:[{code:'J0585',units:1,amount_cents:1500,diagnosis_codes:['M62.81']}]};
 setAccount(draft);
 const directory={providers:[{id:'other',npi:'1234567893',display_name:'Another clinician'}],billing_organizations:[{name:'Group',npi:''}],facilities:[{name:'Office',address:'1 Synthetic Way'}]};
 const preview=()=>review({...postSummary(),practice_directory:directory});
 let recording=preview();
 assert.ok(recording.some(row=>row.key==='insurance-subscriber_birth_date'),'a dependent on a selected secondary policy needs their subscriber date');
 draft.content.coverage_id=primary.id;
 recording=preview();
 assert.deepEqual(Array.from(recording,row=>row.key).filter(key=>key!=='note-unsigned').sort(),['line-0-ndc','practice-rendering_npi'],'one rendering NPI supplies both roles for a practice using the clinician NPI, with the separate drug detail still shown');
 const interrupted=review({...postSummary(),practice_directory:null});
 assert.ok(interrupted.some(row=>row.key==='practice-directory-unavailable'&&row.attribute==='data-visit-review-refresh'));
 assert.ok(!interrupted.some(row=>row.key==='practice-billing_npi'||row.key==='practice-rendering_npi'));
 draft.content.coverage_id=null;
 assert.deepEqual(Array.from(preview(),row=>row.key),['self-pay'],'explicit self-pay on charges stays self-pay when the patient has active insurance');
 const organizations=[{name:'Synthetic Billing Group One',npi:'1245319599'},{name:'Synthetic Billing Group Two',npi:'1548469802'}];
 const multiDirectory={...directory,providers:[{id:'assigned',npi:'1234567893',display_name:'Assigned Clinician'}],billing_organizations:organizations};
 const ambiguous=reviewSummary({practice_directory:multiDirectory,claim:{...claim,content:{...filled(),billing_npi:'',tax_id:'',rendering_npi:'1234567893'},issues:[{code:'npi',missing:'provider NPI'},{code:'tax_id',missing:'billing organization tax ID'}]}});
 const ambiguousChecks=review(ambiguous);
 assert.equal(ambiguousChecks.find(row=>row.key==='practice-billing_npi')?.text,'Confirm which organization bills this claim.');
 assert.ok(!ambiguousChecks.some(row=>row.key==='practice-rendering_npi'),'the assigned clinician’s valid rendering NPI remains on the claim');
 const rendered=ctx.visitSignedClaimDetailBody(ambiguous,{canWrite:true,claimsAllowed:true},false);
 assert.match(rendered,/data-visit-claim-fix="claim" data-signed-focus="billing_provider_name">Edit billing details/);
 const corrected=review({...ambiguous,claim:{...ambiguous.claim,content:{...ambiguous.claim.content,billing_provider_name:'Synthetic Billing Group Two',billing_npi:'1548469802',tax_id:'000000018'},issues:[]}});
 assert.ok(!corrected.some(row=>['practice-billing_npi','practice-rendering_npi','practice-tax'].includes(row.key)),'the reviewed billing identity resolves the claim checks');
 ctx.billingPayers.pop();ctx.workspace.billing.coverages.pop();delete ctx.workspace.patient.birth_date;delete ctx.activeVisit.clinician_id;
 ctx.claimmdClaimProviderDefaults=heldProviders;ctx.claimmdSubscriberBirthMissing=heldSubscriber;
 // ---- The panel renders the two lists, the money summary and the form ----
 reset();openPanel(reviewSummary());
 let panel=panelHost().innerHTML;
 assert.match(panel,/encounter-review-items/);assert.doesNotMatch(panel,/data-visit-review-close/);
 assert.match(panel,/1 service line · \$280.00/);assert.match(panel,/\$280\.00/,'the charges total is said');
 assert.match(panel,/Synthetic Medicare PPO/,'who is billed is said');assert.match(panel,/\$10\.00/,'the expected copay is said');
 assert.match(panel,/data-encounter-claim-form>View claim form/,'the CMS-1500 sheet is offered, and opening it sends nothing');
 assert.match(panel,/data-visit-review-send/,'the one send button is there');
 // A claim carrying its own copy of the encounter's charge lines has each of them drawn on the form.
 // The line mapper shadows its own name inside the map callback on the main branch, so a claim with
 // lines crashes instead of rendering; this is the case that catches it.
 openPanel(reviewSummary({claim:{id:claim.id,status:'ready',version:claim.version,content:claim.content,snapshot:claim.snapshot}}));
 panel=panelHost().innerHTML;
 assert.match(ctx.visitReviewFormMarkup(reviewState().data.summary),/visit-billing-review-lines/,'the claim\'s charge lines are drawn on the form');
 assert.match(panel,/99213/,'and the line\'s code is on it');
 assert.match(panel,/M62\.81/,'with the diagnosis pointer resolved to its code');
 // A must-fix disables the send button until it is put right.
 openPanel(reviewSummary({claim:{id:'claim',status:'draft',version:2,content:{...filled(),place_of_service:''},snapshot:claim.snapshot,issues:[{code:'tax_id',missing:'billing organization tax ID',detail:'Tax ID is required'}]}}));
 panel=panelHost().innerHTML;
 assert.match(panel,/data-review-level="must"/);assert.match(panel,/things to fix before sending/);
 assertMustFixFooter();
 assert.match(panel,/Edit claim details/,'the must fix carries its one way forward');

 // ---- The chain, in order, with the failures stopping where they happen ----
 reset();showOnScreen(reviewSummary());
 let ran=await runChain('claim',{allowUnsigned:true,needPost:false,needPrepare:false});
 assert.equal(ctx.failed,null,ctx.failed);assert.equal(ran,true);
 assert.deepEqual(sent.map(c=>[c.path,c.method]).filter((c,i,a)=>!(c[0]==='/api/v1/billing/claims/claim'&&c[1]==='GET'&&a.some((p,j)=>j<i&&p[0]===c[0]&&p[1]==='GET'))),[
  ['/api/v1/billing/claims/claim','GET'],
  ['/api/v1/billing/claims/claim/actions','POST']],
  'the claim is read and released before opening the native confirmation form');
 assert.equal(sent.filter(c=>c.path==='/api/v1/billing/claims/claim'&&c.method==='GET').length,3,'the native form reads the released claim');
 assert.deepEqual(ctx.nativeReview,{id:'claim',accountId:'account',version:3});
 const ready=sent.find(c=>c.path.endsWith('/actions'));
 assert.equal(ready.body.action,'ready');assert.equal(ready.version,2,'release carries the claim version it read');
 assert.equal(sent.filter(c=>c.path.endsWith('/837p')||c.path.endsWith('/delivery')).length,0,'opening the form never generates or queues a claim');

 // The whole chain from a draft account: post first, with the server's version.
 reset();setAccount(accountOf({status:'draft'}));ctx.unsigned=false;
 showOnScreen(postSummary());
 vm.runInContext('visitReviewRun',ctx)(claim.id,{needPost:true,needPrepare:false,allowUnsigned:true,confirmPost:true}).then(r=>{ctx.chainRan=r;},e=>{ctx.chainErr=e.message;});await settle();
 ran=ctx.chainRan;
 assert.equal(ran,true,ctx.failed||JSON.stringify(sent));
 assert.equal(ctx.workspace.billing.accounts[0].status,'posted','the client applies the posting response before native review');
 const paths=sent.filter(c=>!c.path.includes('/visit-summary')).map(c=>[c.path,c.method]);
 assert.equal(paths[0][0],'/api/v1/patients/patient/billing/accounts/account/actions');assert.equal(paths[0][1],'POST');
 assert.deepEqual(paths.slice(1).filter((c,i,a)=>!(c[1]==='GET'&&i>0&&a[i-1][0]===c[0])),[
  ['/api/v1/billing/claims/claim','GET'],
  ['/api/v1/billing/claims/claim/actions','POST'],
  ['/api/v1/billing/claims/claim','GET']],
  'post comes first, then release the claim and open the current native confirmation form');
 assert.equal(sent[0].body.action,'post');assert.equal(sent[0].version,4,'the post carries the account version');
 assert.ok(sent[0].body.reason.trim().length>0&&sent[0].body.reason.length<=1000,'the post carries a reason');
  // A chain that cannot find its claim stops where it is and sends nothing onward.
  reset();setAccount(accountOf({status:'draft'}));showOnScreen(postSummary());
  // The server prepares nothing: after the post the screen still shows no claim for this encounter.
  vm.runInContext("var _api=api;api=async(p,m,b,v)=>{if(p.indexOf('/claims/prepare')>=0)return {outcome:'not_prepared',issues:['no charges to claim']};return _api(p,m,b,v);}",ctx);
   ran=await vm.runInContext('visitReviewRun',ctx)(null,{needPost:true,needPrepare:true,allowUnsigned:true,confirmPost:true});
  vm.runInContext('api=_api',ctx);
 assert.equal(ran,false,'a chain that cannot find its claim stops');
 assert.equal(sent.filter(c=>c.path.endsWith('/837p')).length,0,'and the claim is never submitted');
 assert.equal(sent.filter(c=>c.path.endsWith('/delivery')).length,0,'nor delivered');
 assert.equal(sent.filter(c=>c.path.endsWith('/actions')&&c.body?.action==='ready').length,0,'nor released');

 // A failure stops the chain at that step, keeps what was done, and says why in plain words.
 reset();setAccount(accountOf({status:'draft'}));ctx.failAt='ready';
 openPanel(reviewSummary({account:{id:'account',status:'draft',version:4,total_cents:28000}}));
 ran=await runChain(claim.id,{needPost:true,needPrepare:false,allowUnsigned:true});
 assert.equal(ran,false,'a failed release stops the run');
 assert.equal(sent.filter(c=>c.path.endsWith('/837p')).length,0,'a failed release never submits');
 assert.equal(sent.filter(c=>c.path.endsWith('/delivery')).length,0,'and never delivers');
 panel=panelHost().innerHTML;
 assert.match(panel,/role="alert"/);assert.match(panel,/Nothing more was sent\./);
 assert.match(panel,/data-visit-review-send>Send claim/,'the footer offers the same send action after a failure');
 assert.match(panel,/data-review-stage="post" class|class="visit-billing-review-step is-done" data-review-stage="post"/,'the step already done stays marked done');
 assert.match(panel,/is-failed/,'and the failed step is shown stopped');
 assert.match(panel,/We could not finish/,'said in a plain sentence');

  // The preflight the server refuses is shown and stops the send before any write.
  reset();ctx.preflight=['Rendering provider NPI is missing'];
  openPanel(reviewSummary());
  ran=await runChain('claim',{needPost:false,needPrepare:false,allowUnsigned:true});
  assert.equal(ran,false,'a refused preflight stops the send');
  assert.equal(sent.filter(c=>c.method==='POST').length,0,'a refused preflight writes nothing');
  assert.match(panelHost().innerHTML,/Nothing more was sent\./,'the panel says so where the person is looking');
  assert.match(panelHost().innerHTML,/Rendering provider NPI is missing/,'the server\u2019s own words come through');
  assert.match(panelHost().innerHTML,/data-visit-review-send>Send claim/,'the footer offers the same send action after a failure');

 // A failure opening the native review restores the footer without transmitting anything.
 reset();ctx.failAt='native-review';openPanel(reviewSummary());
 ran=await runChain('claim',{needPost:false,needPrepare:false,quietRefresh:true});
 assert.equal(ran,false);assert.match(panelHost().innerHTML,/data-review-stalled/);
 assert.match(panelHost().innerHTML,/Synthetic native review failure/);
 assert.match(panelHost().innerHTML,/data-visit-review-send/);
 assert.equal(sent.filter(c=>c.path.endsWith('/837p')||c.path.endsWith('/delivery')).length,0,'a native-review failure creates no file or delivery');

 // Existing prepared files and recorded submissions both stop a second attempt.
 for(const guard of ['claimHasPreparedSubmission','claimHasRecordedSubmission']){
  reset();vm.runInContext(`${guard}=()=>true`,ctx);
  ran=await runChain('claim',{needPost:false,needPrepare:false});
  assert.equal(ran,false);
  assert.equal(ctx.nativeReview,null,'an existing claim file or submission prevents another native review');
  assert.equal(sent.filter(c=>c.method==='POST').length,0,'an existing file or submission prevents release, generation and delivery');
  vm.runInContext(`${guard}=()=>false`,ctx);
 }

 // ---- An unsigned note cannot send, including a stale acknowledgement ----
 reset();ctx.unsigned=true;ctx.activeVisit.status='in_progress';setAccount(accountOf({status:'draft'}));
 openPanel(postSummary());
 panel=panelHost().innerHTML;
 assert.match(panel,/Sign the note to build the claim\. Problems to fix before sending:/);
 assert.equal((panel.match(/Sign the note to build the claim/g)||[]).length,1);
 assert.doesNotMatch(panel,/data-review-note-ask|data-note-sign-ack|Until the note is signed|The encounter note is not signed yet/);
 for(const checked of [false,true]){
  panelHost()._q={'[data-note-sign-ack]':{checked}};
  click({'visit-review-send':''});await settle();if(ctx.failed)throw new Error(ctx.failed);
  assert.equal(sent.length,0,'an unsigned note writes nothing even with a stale acknowledgement');
  assert.equal(ctx.visitReviewSendContext(reviewState().data.summary,account),null);
 }
 ctx.unsigned=false;ctx.activeVisit.status='signed';
 openPanel(postSummary());
 click({'visit-review-send':''});await settle();if(ctx.failed)throw new Error(ctx.failed);
 assert.deepEqual(ctx.nativeReview,{id:'claim',accountId:'account',version:3});
 assert.equal(sent.filter(c=>c.path.endsWith('/837p')||c.path.endsWith('/delivery')).length,0,'continuing to the native review does not submit or queue');
 assert.deepEqual(sent.filter(c=>!c.path.includes('/visit-summary')).map(c=>[c.path.replace(/^\/api\/v1\/patients\/patient\/billing/,'').replace('/api/v1',''),c.method]),[
   ['/accounts/account/actions','POST'],
   ['/accounts/account/claims/prepare','POST'],
   ['/billing/claims/claim','GET'],
   ['/billing/claims/claim/actions','POST'],
   ['/billing/claims/claim','GET']],
   'the chain posts, fills in, reads and releases the claim, then opens the native form');
  // The post from the panel confirms first; a cancelled ask sends nothing.
  reset();setAccount(accountOf({status:'draft'}));
  vm.runInContext('confirmAction=async()=>false',ctx);
  ran=await runChain(claim.id,{needPost:true,needPrepare:false,allowUnsigned:true,confirmPost:true});
  assert.equal(ran,false,'a cancelled post stops before anything else');
  assert.equal(sent.length,0,'a cancelled ask writes nothing');
  vm.runInContext('confirmAction=async()=>true',ctx);

 // A disabled button refuses even a synthetic press on an otherwise clean claim.
 reset();openPanel(reviewSummary());
 assert.equal(review(reviewState().data.summary).filter(check=>check.level==='must').length,0);
 click({'visit-review-send':''},{disabled:true});await settle();if(ctx.failed)throw new Error(ctx.failed);
 assert.equal(sent.length,0,'a disabled send button starts no API calls');

 // A must-fix swallows the press even if the button's disabled state is bypassed.
 reset();ctx.unsigned=false;
 openPanel(reviewSummary({claim:{id:'claim',status:'draft',version:2,issues:[{code:'tax_id',missing:'billing organization tax ID',detail:'Tax ID is required'}]}}));
 assertMustFixFooter();
 click({'visit-review-send':''});await settle();if(ctx.failed)throw new Error(ctx.failed);
 assert.equal(sent.length,0,'the send cannot be pressed past a must fix');

 // ---- The card's one main button ----
 const all={canCreate:true,canWrite:true,claimsAllowed:true};
 // The panel is open on another visit's card: this card keeps its own button instead.
 setAccount(accountOf());
 let out=ctx.visitBillingCardMarkup(reviewSummary({visit:{id:'another-visit',appointment_id:'other',status:'signed'}}),all);
 assert.equal((out.match(/Review and send to the clearinghouse/g)||[]).length,0,'a card drawn away from the live visit keeps its own button');
 assert.match(out,/Review and send claim|Fix claim details|Post charges|Prepare claim/,'and it still offers the encounter its own next step');
 showOnScreen(reviewSummary());
 out=ctx.visitBillingCardMarkup(reviewSummary(),all);
 assert.match(out,/class="primary" data-visit-review-open="account">Review and send to the clearinghouse</);
 assert.equal((out.split('<section id="visit-billing-review"')[0].match(/class="primary"/g)||[]).length,1,'one primary button on the encounter bar card');
  out=ctx.visitBillingCardMarkup(reviewSummary(),{...all,delegated:true});
  assert.match(out,/Review and send to the clearinghouse/,'a support session gets the same review-and-send panel');
 showOnScreen(reviewSummary({claim:{id:'claim',status:'submitted',version:3}}));
 out=ctx.visitBillingCardMarkup(reviewSummary({claim:{id:'claim',status:'submitted',version:3}}),all);
 assert.doesNotMatch(out,/Review and send to the clearinghouse/,'a claim already with the insurer is not offered again');
 assert.match(out,/data-visit-billing-sent/);assert.match(out,/Check status/,'the card says where the claim is and gives one way to look');

  // ---- No horizontal overflow is invited ----
  const css=fs.readFileSync('web/visit-billing.css','utf8');
  for(const block of css.split('}')){
    if(!/visit-billing-review/.test(block))continue;
    assert.doesNotMatch(block,/width:\s*\d{4,}px|min-width:\s*(?!0|1|2)\d{3,}px/,`review styles must not force a wide layout: ${block.trim().slice(0,80)}`);
  }
  // The claim line table is the one wide thing in the panel; it keeps its own scroll box and
  // no rule lets it widen the panel.
  const linesRule=css.split('\n').find(l=>l.startsWith('.visit-billing-review-lines'));
  assert.ok(linesRule&&/min-width:0/.test(linesRule),'the line table gives way instead of widening the panel');
  const global=fs.readFileSync('web/style.css','utf8');
  assert.match(global,/\.billing-table-wrap\{overflow:auto\}/,'the table wrap the panel reuses already scrolls inside itself');

 // ---- Opening and closing the panel ----
 reset();openPanel(reviewSummary());
 assert.equal(panelHost().hidden,false,'the panel opens in place');
 click({'visit-review-close':''});
 assert.equal(panelHost().hidden,false,'the claim screen remains the destination');
 assert.match(panelHost().innerHTML,/claim-screen-footer/,'the screen retains its footer');

 // Sending on the mounted Visit must never select another step.
 reset();showOnScreen(reviewSummary());node('visit-page-host').dataset.encounterSteps='';
 let stepChanges=0;ctx.encounterStepOpen=()=>{stepChanges++;};ctx.encounterContentScroll=()=>{throw new Error('Send must keep the page stationary');};ctx.encounterStepsSchedule=()=>{};
 assert.equal(await runChain(claim.id,{needPost:false,needPrepare:false}),true);
 assert.equal(stepChanges,0);delete node('visit-page-host').dataset.encounterSteps;
 console.log('PASS mounted send updates Claim on the continuous encounter without scrolling');
 console.log('PASS review panel: plain checks split into must-fix and worth-a-look, CMS-1500 view and money summary, the chain in order with a failure stopping at its step, signature required before sending, must fixes closing the send, and one card button per live visit');
})().catch(error=>{console.error(error);process.exitCode=1;});
