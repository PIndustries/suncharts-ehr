// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {visitSummary}=require('./visit_billing_fixture.cjs');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const handlers=[],nodes={};
const node=id=>nodes[id]??={innerHTML:'',hidden:false,dataset:{},querySelector:()=>null,scrollIntoView(){this.scrolled=true;},scrollTo(options){this.scrollOptions=options;},focus(){this.focused=true;}};
const account={id:'account',status:'posted',content:{service_date:'2026-11-12',lines:[
 {code:'SYN01',units:2,amount_cents:8000,modifiers:['AA'],diagnosis_codes:['R05.9','R53.83']},
 {code:'SYN02',units:1,amount_cents:2000,diagnosis_codes:['R53.83']}
]},coverage_snapshot:{coverage:{id:'coverage',content:{member_id:'SYN123',priority:'primary'}},payer:{content:{name:'Synthetic Plan',payer_code:'SYN'}}}};
const content={billing_provider_name:'Synthetic Clinic',billing_address:'1 Synthetic Road',tax_id:'123456789',billing_npi:'1234567890',rendering_npi:'0987654321',subscriber_address:'1 Synthetic Road',subscriber_birth_date:'1980-01-01',place_of_service:'11',diagnosis_codes:['R05.9','R53.83'],line_diagnosis_pointers:[[1,2],[2]],encounter:{prior_authorization_number:'SYN-PA',referring_provider_name:'Synthetic Referrer'}};
const ctx={console,Date,Intl,URL,Map,Set,Array,Math,Number,String,JSON,selected:'patient',me:{role:'owner'},$:node,esc,money:n=>'$'+(n/100).toFixed(2),
 visitNoteReadMarkup:note=>'<p>'+esc(note.subjective||'')+'</p>',
 activeVisit:{id:'visit',status:'signed',note:{subjective:'Synthetic note <safe>'}},
 encounterRevenueState:{data:null,review:null},encounterChargeAccount:()=>account,billingCan:()=>true,
 visitBillingStateContext:()=>({canWrite:true,canCreate:true,claimsAllowed:true}),
 document:{addEventListener:(name,fn)=>{if(name==='click')handlers.push(fn);}},
 invoiceTabSet:key=>{node('encounter-revenue').dataset.invoiceTab=key;},billingPartSet:key=>{node('encounter-revenue').dataset.billingPart=key;},
 encounterCodesEvidence:{visit:'visit',evidence:{diagnoses:[{code:'R53.83',display:'Synthetic diagnosis two'},{code:'R05.9',display:'Synthetic diagnosis one'}]}},
 insuranceEligibilityState:{items:new Map([['coverage',{}]])},insuranceEligibilityMarkup:()=>'<p>Recorded eligibility result</p>'};
vm.createContext(ctx);
for(const file of ['billing.js','visit-billing.js','visit-review.js'])vm.runInContext(fs.readFileSync('web/'+file,'utf8'),ctx);
const all={canWrite:true,canCreate:true,claimsAllowed:true};
const summary=(state='send_claim',status='draft')=>visitSummary({state,charges_cents:10000,claim:{id:'claim',status,content,snapshot:{account}},patient:{owes_now_cents:1000}});
const draw=(s,extra={})=>{ctx.encounterRevenueState.data={summary:s};return ctx.visitReviewPanelMarkup(s,{...all,...extra});};
const card=(html,key)=>html.match(new RegExp(`<section class="claim-card[^\"]*" data-claim-card="${key}">([^]*?)</section>`))?.[1]||'';
const footer=html=>html.slice(html.indexOf('<footer'));
let html=draw(summary());
assert.deepEqual([...html.matchAll(/data-claim-card="([^"]+)"/g)].map(m=>m[1]),['visit','insurance','diagnoses','services']);
assert.match(card(html,'visit'),/Synthetic Clinic/);assert.match(card(html,'visit'),/Synthetic Referrer/);
assert.match(card(html,'insurance'),/SYN123/);assert.match(card(html,'insurance'),/Recorded eligibility result/);
assert.match(card(html,'diagnoses'),/<td>A<\/td><td>R05.9<\/td><td>Synthetic diagnosis one/,'diagnoses follow the charge order, with their descriptions');
assert.match(card(html,'services'),/2 service lines · \$100.00/);
assert.match(card(html,'services'),/data-encounter-codes-anchor>Edit codes ↑/);
assert.doesNotMatch(card(html,'services'),/<table|<th>Modifiers|<th>Units/,'claim does not repeat the charge table');
assert.match(card(html,'diagnoses'),/Line 1 · SYN01: A, B/);
assert.match(card(html,'diagnoses'),/Line 2 · SYN02: B/);
assert.doesNotMatch(html,/Synthetic note &lt;safe&gt;/);assert.match(html,/class="claim-screen-columns"/);assert.doesNotMatch(html,/class="claim-preview"/);
assert.doesNotMatch(html,/<textarea/,'claim does not repeat the note');
assert.match(html,/data-encounter-claim-form>View claim form/);
const click=dataset=>{const button={dataset,closest:()=>null,hasAttribute:name=>name.replace(/^data-/,'').replace(/-([a-z])/g,(_,c)=>c.toUpperCase()) in dataset};for(const fn of handlers)fn({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});};
// Route every check without losing its original fix action. Include generic server errors.
const original=ctx.visitReviewChecks;
ctx.visitReviewChecks=()=>[
 ['practice-npi','practice','Practice needs details','visit'],['patient-address','patient','Patient needs details','insurance'],
 ['insurance','insurance','Coverage needs details','insurance'],['diagnoses','claim','Diagnosis codes missing','diagnoses'],
 ['line-0-diagnosis','claim','Line 1 has no diagnosis','services'],['server-place','claim','Invalid place of service','visit'],
 ['server-claim','claim','Claim needs details','services']
].map(([key,group,text])=>({key,group,text,level:'must',action:'Fix synthetic issue',attribute:`data-synthetic-fix="${key}"`}));
html=draw(summary());
for(const [key,target] of [['practice-npi','visit'],['patient-address','insurance'],['insurance','insurance'],['diagnoses','diagnoses'],['line-0-diagnosis','services'],['server-place','visit'],['server-claim','services']]){
 assert.ok(card(html,target).includes(`data-check="${key}"`),`${key} belongs to ${target}`);
 assert.ok(card(html,target).includes(`data-synthetic-fix="${key}"`),'existing fix button preserved');
 assert.match(html,new RegExp(`class="claim-card has-blocking" data-claim-card="${target}"`));
}
assert.match(footer(html),/7 things to fix before sending/);assert.match(footer(html),/data-visit-review-send disabled>Send claim/);assert.match(footer(html),/data-claim-problems>7 things to fix/);
ctx.visitReviewChecks=original;
for(const [state,status,label] of [['send_claim','draft','Send claim'],['post_charges','draft','Send claim'],['claim_cancelled','void','Send the claim again'],['waiting_insurer','submitted',null]]){
 html=draw(summary(state,status));
 assert.deepEqual([...footer(html).matchAll(/class="primary"[^>]*>([^<]+)</g)].map(m=>m[1]),label?[label]:[],`${state}: one footer action or none`);
}
for(const status of ['draft','ready','submitted','accepted','rejected','adjudicated','void']){
 html=draw(summary(status==='void'?'claim_cancelled':'send_claim',status));
 assert.equal(/data-prior-auth-edit/.test(card(html,'services')),status==='draft',`${status}: authorization edits only on a draft`);
 assert.match(card(html,'services'),/SYN-PA/);
 if(status==='draft')assert.match(card(html,'services'),/data-prior-auth-save>Save/);
}
html=draw(summary('waiting_insurer','submitted'));
assert.ok(html.indexOf('data-claim-status')<html.indexOf('data-claim-card="visit"'),'status comes first after sending');
assert.match(html,/data-claimmd-check="claim"/);
assert.doesNotMatch(html,/data-details-edit|data-visit-review-fix|data-encounter-charges|data-chart-section="insurance"|data-prior-auth-edit/,'sent claim cards are read-only');
// Read-only takes effect immediately, before the refreshed summary arrives.
html=draw(summary(),{sent:true});
assert.match(html,/Sent to the clearinghouse/);assert.doesNotMatch(html,/data-prior-auth-edit|data-encounter-charges/);
html=draw(summary(),{canWrite:false});assert.doesNotMatch(html,/data-prior-auth-edit|class="primary"/);
ctx.encounterRevenueState.review={busy:true};html=draw(summary());
assert.match(footer(html),/data-visit-review-send disabled/);ctx.encounterRevenueState.review=null;
ctx.activeVisit.status='in_progress';html=draw(summary());
assert.doesNotMatch(html,/data-review-note-ask/);assert.doesNotMatch(html,/data-claim-note/);ctx.activeVisit.status='signed';
ctx.activeVisit.status='in_progress';
assert.equal(ctx.visitReviewUnsignedAllowed({allowUnsigned:true}),false);
ctx.activeVisit.status='signed';
assert.equal(ctx.visitReviewUnsignedAllowed({}),false);
assert.equal(ctx.visitReviewUnsignedAllowed({allowUnsigned:true}),true);
ctx.encounterRevenueVisitUnsigned=()=>true;
html=draw(summary(),{allowUnsigned:true});
assert.match(html,/<details data-claim-more-actions><summary>More claim actions<\/summary><label data-review-note-ask>/);
delete ctx.encounterRevenueVisitUnsigned;
// Old callers move out of an editor or another tab, without sending anything.
node('encounter-revenue').dataset={invoiceTab:'note',billingPart:'codes',codesEditing:''};
ctx.encounterCodesEditorClose=()=>{assert.equal(node('encounter-revenue').codesCloseNow,true);delete node('encounter-revenue').dataset.codesEditing;};
click({visitReviewOpen:'account'});
assert.equal(node('encounter-revenue').dataset.invoiceTab,'billing');assert.equal(node('encounter-revenue').dataset.billingPart,'summary');
assert.equal(node('encounter-revenue').dataset.codesEditing,undefined,'the codes overlay closes before navigation');
assert.equal(node('claim-screen-footer').scrolled,undefined);assert.equal(node('visit-billing-review').scrollOptions.behavior,'smooth');assert.equal(node('claim-screen-footer').focused,true);
// Loaded directory names and immutable claim names both keep the NPI secondary.
ctx.claimmdProviderDefaults={providers:[{npi:'0987654321',display_name:'Dr. Synthetic <Clinician>'}]};
html=draw(summary());assert.match(card(html,'visit'),/Dr. Synthetic &lt;Clinician&gt; <span class="muted">NPI 0987654321<\/span>/);
assert.match(ctx.visitClaimRenderingProvider({...content,rendering_provider_name:'Recorded Synthetic Provider'},{}),/^Recorded Synthetic Provider <span class="muted">NPI/);
// One diagnosis problem from local checks and several server messages shares a code.
const missing=summary('fix_claim');missing.claim.content={...content,diagnosis_codes:[]};
missing.claim.issues=[{code:'diagnosis_codes',missing:'diagnosis codes'},{code:'diagnosis_codes',detail:'different server words'},{code:'synthetic_other',missing:'another detail'},{code:'synthetic_other',detail:'alternate words'}];
const checks=ctx.visitReviewChecks(missing,all);
assert.equal(checks.filter(c=>c.key==='diagnoses').length,1);assert.equal(checks.filter(c=>c.key==='server-synthetic_other').length,1);
html=draw(missing);assert.equal((html.match(/data-check="diagnoses"/g)||[]).length,1);assert.match(html,/The claim needs its diagnosis codes\./);assert.doesNotMatch(html,/The claim is missing diagnosis codes/);
assert.doesNotMatch(ctx.visitBillingCardMarkup(missing,all),/visit-billing-missing|Fill in what is missing/);

// Missing practice fields retain all findings and share one setup action.
const practiceMissing=summary('fix_claim');practiceMissing.claim.content={...content,tax_id:'',billing_npi:'',rendering_npi:'',billing_address:''};
html=draw(practiceMissing);
const practiceChecks=ctx.visitReviewChecks(practiceMissing,all).filter(check=>check.attribute==='data-billing-organizations');
assert(practiceChecks.length>1);
assert.equal((html.match(/>Open practice billing setup<\/button>/g)||[]).length,1);
for(const check of practiceChecks)assert(html.includes(esc(check.text)));
ctx.activeVisit.status='in_progress';
const unsigned=summary();unsigned.visit={id:'visit',status:'in_progress'};unsigned.claim.snapshot={account:{...account,status:'draft'}};
html=draw(unsigned,{canSign:true});assert.equal((html.match(/Sign the note to build the claim/g)||[]).length,1);ctx.activeVisit.status='signed';

// Unsigned practice findings immediately follow the single signature instruction.
ctx.activeVisit.status='in_progress';
html=draw(practiceMissing,{canSign:true});
const practiceDom=new (require('jsdom').JSDOM)(html),signature=practiceDom.window.document.querySelector('[data-claim-signature-message]');
assert(signature.nextElementSibling.matches('.claim-practice-problems'));
assert.equal(practiceDom.window.document.querySelectorAll('[data-billing-organizations]').length,1);
assert.doesNotMatch(html,/Until the note is signed|The encounter note is not signed yet|Send anyway/);
practiceDom.window.close();ctx.activeVisit.status='signed';

// Reserve the real footer height, including taller wrapped/error states, in this scroll area.
const properties={};ctx.window={innerHeight:900};
Object.assign(node('visit-billing-review'),{style:{setProperty:(k,v)=>properties[k]=v},getClientRects:()=>[{}],getBoundingClientRect:()=>({top:250})});
let footerHeight=92;node('claim-screen-footer').getBoundingClientRect=()=>({height:footerHeight});
ctx.visitClaimLayout();assert.equal(properties['--claim-footer-height'],'92px');assert.equal(properties['--claim-area-height'],'634px');
footerHeight=148;ctx.visitClaimLayout();assert.equal(properties['--claim-footer-height'],'148px');
const css=fs.readFileSync('web/visit-billing.css','utf8');
assert.match(css,/@media\(min-width:1000px\).*grid-template-columns:minmax\(0,1fr\)/);
assert.match(css,/\.claim-preview\{position:sticky/);assert.match(css,/\.claim-screen-footer\{position:sticky;bottom:0/);
assert.match(css,/\.claim-screen\{[^}]*overflow:auto/);assert.match(css,/\.claim-screen-columns\{[^}]*padding-bottom:var\(--claim-footer-height,90px\)/);assert.match(css,/\.claim-screen-footer\{[^}]*width:100%[^}]*border:1px solid var\(--line\)[^}]*background:var\(--surface\)/);
console.log('PASS claim screen: ordered cards, inline problems and fixes, footer states, draft authorization, read-only sent claim, preview switch and legacy navigation');

// The unsigned preview reads unsaved codes and encounter-date coverage without building a claim.
ctx.activeVisit={id:'visit',status:'in_progress',note:{subjective:'Synthetic note'}};
const draft={...account,status:'draft',content:{...account.content,visit_id:'visit'}};
ctx.encounterChargeAccount=()=>draft;
const liveLine={code:'SYN-LIVE',units:1,amount_cents:12300,diagnosis_codes:[]};
node('billing-account-form').elements={visit_id:{value:'visit'},service_date:{value:'2030-11-15'}};
ctx.chargeLiveRows=()=>[liveLine];ctx.chargeRowValue=row=>({...row});
let currentCoverage={id:'coverage',content:{payer_id:'payer',member_id:'LIVE-MEMBER',priority:'primary',plan_name:'Live Plan'}};
ctx.revenueCoverage=()=>currentCoverage;ctx.workspace={billing:{coverages:[]}};
vm.runInContext("billingPayers=[{id:'payer',content:{name:'Live Insurer',payer_code:'SYN'}}]",ctx);
let draftSummary=visitSummary({state:'sign_visit',account:draft,claim:null});
html=draw(draftSummary);
assert.match(html,/Sign the note to build the claim\. Problems to fix before sending:/);assert.match(html,/SYN-LIVE/);assert.match(html,/LIVE-MEMBER/);
assert.match(html,/data-check="line-0-diagnosis" data-check-level="must"/);
assert.match(html,/\$123.00/);assert.doesNotMatch(html,/class="claim-preview"/);
liveLine.code='SYN-CHANGED';liveLine.amount_cents=23400;liveLine.diagnosis_codes=['R05.9'];
html=draw(draftSummary);assert.match(html,/SYN-CHANGED/);assert.match(html,/\$234.00/);assert.doesNotMatch(html,/data-check="line-0-diagnosis"/);
currentCoverage=null;html=draw(draftSummary);
assert.match(html,/1 service line/);assert.match(html,/Patient will owe.*\$234.00/);
assert.doesNotMatch(html,/insurance|insurer|clearinghouse|copay|Member ID/i);
console.log('PASS live unsigned preview: unsaved service lines, current coverage, blockers and self-pay wording');

// Embedded claim content is flat and does not create a second scroller or sticky action bar.
assert.match(css,/#visit-page-host\[data-encounter-steps\] \.claim-screen\{max-height:none;overflow:visible\}/);
assert.match(css,/#visit-page-host\[data-encounter-steps\] \.claim-screen-footer\{position:static\}/);

// Draft claim fixes follow their destination and the staff member's authority.
const draftChecks=[
 {key:'practice-address',group:'practice',level:'must',text:'Missing billing address.',action:'Open practice billing setup',attribute:'data-billing-organizations'},
 {key:'practice-tax',group:'practice',level:'must',text:'Invalid private tax ID.',action:'Open practice billing setup',attribute:'data-billing-organizations'},
 {key:'practice-rendering_npi',group:'practice',level:'must',text:'Missing assigned clinician NPI.',action:'Edit provider',attribute:'data-practice-providers'},
 {key:'line-2-ndc',group:'claim',level:'note',text:'Drug line missing an NDC.',action:'Add the drug detail',attribute:'data-visit-review-fix="line" data-review-line="2" data-review-field="ndc_code"'},
 {key:'note-unsigned',group:'visit',level:'must',text:'Sign the note.',action:'Sign the note',attribute:'data-visit-review-fix="note"'}];
ctx.me={role:'owner'};ctx.draftChecks=draftChecks;
const draftList=options=>{ctx.draftCtx=options;return vm.runInContext('visitDraftClaimIssues(draftChecks,draftCtx)',ctx);};
const ownerList=draftList({claimsAllowed:true,canWrite:true});
assert.equal((ownerList.match(/data-draft-claim-fix-group/g)||[]).length,3);
assert.equal((ownerList.match(/data-billing-organizations/g)||[]).length,1);
assert.equal((ownerList.match(/data-practice-providers/g)||[]).length,1);
assert.match(ownerList,/Drug line missing an NDC/);assert.doesNotMatch(ownerList,/Sign the note|Invalid private tax ID/);
ctx.me={role:'clinician'};
assert.doesNotMatch(draftList({claimsAllowed:true,canWrite:true}),/data-billing-organizations|data-practice-providers/);
assert.doesNotMatch(draftList({claimsAllowed:true,canWrite:false}),/<button/);
console.log('PASS draft claim issues group by fix target, distinguish warnings, and enforce action visibility');

// A signed, insured chart presents a single actionable claim summary; details keep the data from this visit.
ctx.me={role:'owner'};ctx.activeVisit={id:'visit',status:'signed',clinician_id:'assigned'};
const noAccount=visitSummary({state:'add_charges',account:null,claim:null,charges_cents:0,practice_directory:{providers:[],facilities:[],billing_organizations:[{id:'org',name:'Synthetic Group',npi:''}]}});
noAccount.insurance={...noAccount.insurance,insured:true,electronic:true,coverage_id:'chosen'};
ctx.encounterChargeAccount=()=>null;ctx.chargeLiveRows=()=>[];
ctx.workspace.billing.coverages=[{id:'chosen',content:{member_id:'MEMBER-42',priority:'primary'}}];
ctx.claimmdClaimProviderDefaults=()=>({billing_provider_name:'Synthetic Group',billing_organization_name:'Synthetic Group',rendering_provider_name:'Assigned clinician',rendering_npi:'',billing_npi:'',billing_address:'Clinic'});
const compact=draw(noAccount,{encounterSteps:true});
assert.match(compact,/data-encounter-claim-summary/);assert.match(compact,/data-signed-claim-summary/);
assert.match(compact,/Claim pending procedure codes/);assert.match(compact,/Claim details/);
assert.doesNotMatch(compact,/Add procedures|data-encounter-codes-anchor|data-visit-review-send/,'the Visit code strip already offers Add codes');
assert.doesNotMatch(compact,/Diagnosis pointers|Claim checks|data-visit-review-send|Member ID|thing.*to fix/);
const detail=ctx.visitSignedClaimDetailBody(noAccount,all,false);
assert.match(detail,/MEMBER-42/);assert.match(detail,/Rendering NPI missing for Assigned clinician/);
assert.match(detail,/Uses the rendering clinician’s NPI/);assert.doesNotMatch(detail,/data-check="practice-billing_npi"/);
assert.match(detail,/data-claim-provider-profile="assigned"/);assert.match(detail,/data-signed-claim-codes="rendering"/);assert.match(detail,/data-claim-secondary-host/);
const denied=visitSummary({state:'denied',claim:{id:'claim',status:'adjudicated'}});
const deniedSummary=draw(denied,{encounterSteps:true});
assert.match(deniedSummary,/Fix and resend claim/);
assert.doesNotMatch(deniedSummary,/data-denial-action|data-denial-appeal/);
assert.match(ctx.visitSignedClaimDetailBody(denied,all,true),/data-denial-action="patient_balance"[\s\S]*data-denial-action="write_off"[\s\S]*data-denial-appeal="claim"/);
assert.doesNotMatch(ctx.visitSignedClaimDetailBody(denied,{...all,canWrite:false},true),/data-denial-action|data-denial-appeal/);
const readonlyDetail=ctx.visitSignedClaimDetailBody(noAccount,{...all,canWrite:false},false);
assert.doesNotMatch(readonlyDetail,/data-signed-claim-codes|data-claim-provider-profile|data-details-edit/);
ctx.activeVisit={...ctx.activeVisit,status:'in_progress'};
const draftRow=draw(noAccount,{encounterSteps:true});
assert.match(draftRow,/data-encounter-claim-summary/);
assert.match(draftRow,/Claim pending visit signature/);
assert.match(draftRow,/data-open-signed-claim-details/);
assert.doesNotMatch(draftRow,/data-signed-claim-summary|data-signed-claim-codes|data-visit-review-send|data-draft-claim-fix-group/);
console.log('PASS Visit claim status: unsigned and signed rows, one codes entry point, selected member ID, field warnings, authorized edits and ancillary controls');
