// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The claim screen itself: a claim that came back shows the plain-words box at the very top, its
// single "Fix and resend" button opens the claim for editing with the problem field focused, and a
// fix that belongs on the insurance opens the insurance instead. Stub DOM only, no jsdom.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}

const account={id:'account',patient_id:'patient',version:5,status:'posted',total_cents:28000,
 content:{visit_id:'visit',service_date:'2026-11-02',coverage_id:'coverage',lines:[{code:'99213',diagnosis_codes:['M62.81']}]},
 coverage_snapshot:{coverage:{content:{relationship:'self',member_id:'SYN-MEMBER-1',priority:'primary'}},payer:{content:{name:'Synthetic Payer'}}}};
const claimContent={billing_provider_name:'Synthetic Clinic',billing_npi:'1234567893',rendering_npi:'1234567893',tax_id:'123456789',billing_address:'1 Synthetic Way',patient_address:'1 Synthetic Way',subscriber_address:'1 Synthetic Way',subscriber_birth_date:'1990-01-01',place_of_service:'11',diagnosis_codes:['M62.81'],line_diagnosis_pointers:[[1]],external_control_number:'',notes:''};
function rejectedClaim(over){
 return Object.assign({id:'claim',patient_id:'patient',account_id:'account',payer_id:'payer',version:3,status:'rejected',
  frequency:'original',control_number:'SYNCLAIM000000001',payer_control_number:'',content:Object.assign({},claimContent),
  snapshot:{patient:{given_name:'Avery',family_name:'Synthetic',mrn:'SYN-MRN'},account}},over||{});
}

// One fresh stub workspace per scenario: the claim screen, the claim editor, and the responses the
// server sent with the claim.
function workspace(replacement,extraDetail){
 const notices=[],chartSections=[],focuses=[],handlers={},nodes={};
 const heading={tabIndex:null,focus(options){focuses.push(Object.assign({field:'heading'},options));}};
 const form={values:{},elements:[],dataset:{request:'stable-request'},inserted:'',
  insertAdjacentHTML(position,html){this.inserted+=html;},
  querySelector(selector){
   if(selector==='#claim-editor-heading')return heading;
   const name=/\[name="(.+)"\]/.exec(selector);
   if(!name)return null;
   return {name:name[1],focus(options){focuses.push(Object.assign({field:name[1]},options));},scrollIntoView(){}};
  }};
 const node=id=>nodes[id]||(nodes[id]={id,innerHTML:'',hidden:false,scrollIntoView(){},insertAdjacentHTML(){},replaceChildren(){this.innerHTML='';},
  querySelector(selector){
   if(selector==='#claim-editor-form')return form;
   if(selector==='#claim-editor-heading')return heading;
   return null;
  }});
 const detail=Object.assign({preflight_issues:[],transport:{},history:{items:[]},
  tracking:{reports:[{received_at:'2026-11-08',evidence:{senderid:'SYN-PAYER',sender_name:'Synthetic Payer',status:'R',message:{status:'R',message:'2377 Invalid Subscriber ID'}}}]}},extraDetail||{});
 const context={console,window:{},Map,Set,JSON,Date,Error,RegExp,Array,String,Object,Number,Boolean,Promise,Symbol,Intl,TypeError,Math,
  crypto:{randomUUID:()=>'stable-request'},
  document:{addEventListener:(type,handler)=>{handlers[type]=(handlers[type]||[]).concat(handler);},
   querySelector:selector=>/name="member_id"/.test(selector)?{focus(options){focuses.push(Object.assign({field:'coverage-member_id'},options));}}:null,
   querySelectorAll:()=>[]},
  $:node,esc:v=>String(v==null?'':v),human:v=>String(v==null?'':v).split('_').join(' '),date:v=>String(v),displayDate:v=>String(v),displayStatus:v=>String(v),money:v=>String(v),
  sourceNotice:()=>'',chargeTable:()=>'',billingWrite:()=>true,
  billingField:(name,label,value)=>`<input name="${name}" value="${value==null?'':value}">`,selectField:name=>`<select name="${name}"></select>`,
  claimMdConnectionState:{connected:false},loadClaimMdConnection:async()=>({connected:false}),claimMdConnectionCard:()=>'',startClaimMdTracking(){},showClaimMdClaimActivity:async()=>{},loadEncounterRevenueStatus:async()=>{},
  claimMdClaimLifecycle:()=>'',supportHelpButton:()=>'',billingPayers:[],workspaceResourceAllowed:()=>true,
  showTool(){},showEraAutomation:async()=>{},showRecoupments:async()=>{},showEraBatches:async()=>{},loadClaimmdProviderDefaults:async()=>{},claimmdClaimProviderDefaults:()=>({}),
  me:{role:'billing_staff'},selected:'patient',chartSection:'visits',encounterSection:'charges',activeVisit:{id:'visit'},
  workspace:{patient:{id:'patient'},billing:{accounts:[account]},demographics:{patient_id:'patient',content:{}}},
  setEncounterSection(){},notice:text=>notices.push(String(text)),showChartSection:key=>chartSections.push(key),
  selectPatient:async()=>{},run:fn=>{context.pending=fn();return context.pending;},
  api:async url=>{
   if(url.endsWith('/history'))return {items:[]};
   if(/\/patients\/[^/]+\/billing$/.test(url))return {accounts:[account]};
   if(url.includes('/remittance-sources'))return {items:[]};
   if(url.includes('/remittances'))return {items:[],next_cursor:null};
   if(url.includes('/payers'))return {items:[]};
   if(url.includes('status-counts'))return {counts:{}};
   if(url.includes('/claims')&&url.endsWith('/claims'))return {items:[replacement],next_cursor:null};
   return Object.assign({claim:replacement},detail);
  },
  FormData:class{constructor(target){return Object.entries(target.values||{})[Symbol.iterator]();}}};
 vm.createContext(context);
 vm.runInContext(fs.readFileSync('web/claim-problems.js','utf8'),context);
 vm.runInContext(fs.readFileSync('web/claims.js','utf8'),context);
 return {context,nodes,notices,chartSections,focuses,form,heading,
  async open(){await context.showClaimsWorkspace();await context.showClaim('claim');return this;}};
}
const open=(over,detail)=>workspace(rejectedClaim(over),detail).open();

(async()=>{
 // 1. The box sits at the top of the claim screen, above the action columns.
 const f=await open();
 const html=f.nodes['claims-detail'].innerHTML;
 assert.match(html,/Why it came back/);
 assert.ok(html.indexOf('Why it came back')<html.indexOf('1. Preview claim'),'the plain-words box comes before the send steps');
 assert.match(html,/does not recognise the member ID/i);
 assert.match(html,/new claim \(code 1\)/,'a pure clearinghouse rejection is explained as a new claim');
 assert.match(html,/>Fix and resend</);
 assert.match(html,/data-claim-fix-field="member_id"/);
 assert.match(html,/The message as it came in/,'the insurer’s own wording is kept alongside the plain words');
 assert.match(html,/2377 Invalid Subscriber ID/);
 // The send column defers to the box rather than repeating itself.
 assert.match(html,/Use <b>Fix and resend<\/b>/);
 assert.doesNotMatch(html,/Read the rejection on this page/,'no second instruction competing with the one button');

 // 2. A denial the payer already took says it goes back as a replacement (7) with their number.
 const denied=await open({payer_control_number:'123456700001'});
 assert.match(denied.nodes['claims-detail'].innerHTML,/replacement \(code 7\)/);
 assert.match(denied.nodes['claims-detail'].innerHTML,/123456700001/);

 // 3. A claim with no answer on file yet gets no box at all.
 const quiet=await open({status:'submitted'});
 assert.doesNotMatch(quiet.nodes['claims-detail'].innerHTML,/Why it came back/);

 // 4. "Fix and resend" on a member ID problem opens the insurance, not a box that is not there.
 const fixMember=await open();
 await fixMember.context.beginClaimFix('claim','member_id');
 assert.deepEqual(fixMember.chartSections,['insurance'],'the insurance is opened, because that is where the member ID lives');
 assert.match(fixMember.notices.join(' '),/not typed into the claim/i);
 assert.match(fixMember.notices.join(' '),/SYNCLAIM000000001/,'staff are told which claim to come back to');
 assert.match(fixMember.notices.join(' '),/new claim \(code 1\)/);
 assert.deepEqual(fixMember.focuses.at(-1),{field:'coverage-member_id',preventScroll:true},'focus lands on the member ID box');

 // 5. A claim-form field is focused on the editor, and the editor explains the resend.
 const fixTax=await open({status:'draft'});
 await fixTax.context.beginClaimFix('claim','tax_id');
 assert.deepEqual(fixTax.focuses.at(-1),{field:'tax_id',preventScroll:true},'the problem field takes focus');
 assert.match(fixTax.form.inserted,/data-claim-fix-notice/);
 assert.match(fixTax.form.inserted,/new claim \(code 1\)/);

 // 6. A claim already on file goes back linked to the original. If the practice's own data cannot
 //    answer, that is a warning and the claim is still opened — never a dead end.
 const refused=workspace(rejectedClaim({payer_control_number:'123456700001'}));
 const refusedDetail={preflight_issues:[],transport:{},tracking:{reports:[]},history:{items:[]}};
 refused.context.api=async url=>{
  if(url.endsWith('/history'))return {items:[]};
  if(/\/patients\/[^/]+\/billing$/.test(url))throw new Error('create a linked replacement rather than another original claim');
  if(url.includes('/remittance-sources'))return {items:[]};
  if(url.includes('/remittances'))return {items:[],next_cursor:null};
  if(url.includes('/payers'))return {items:[]};
  if(url.includes('status-counts'))return {counts:{}};
  if(url.endsWith('/claims'))return {items:[rejectedClaim({payer_control_number:'123456700001'})],next_cursor:null};
  return Object.assign({claim:rejectedClaim({payer_control_number:'123456700001'})},refusedDetail);
 };
 await refused.context.showClaimsWorkspace();
 await refused.context.showClaim('claim');
 await refused.context.beginClaimFix('claim','tax_id');
 assert.match(refused.nodes['claim-editor'].innerHTML,/<form id="claim-editor-form"/,'the claim is still opened rather than refused');
 assert.match(refused.form.inserted,/could not start the linked corrected claim/i,'the refusal is explained as a warning, not thrown at staff');
 assert.match(refused.form.inserted,/replacement \(code 7\)/,'and the way it goes back out is still said');

 // 7. Nobody is hard-stopped: an answer we cannot match still opens the form with focus on it.
 const unknownFix=await open({status:'draft'});
 await unknownFix.context.beginClaimFix('claim','');
 assert.equal(unknownFix.focuses.at(-1).field,'heading','with no field to fix, focus still lands on the form');

 // 8. A crossover claim has no corrected claim to prepare, so no box is offered at all.
 const crossed=await open({status:'rejected',crossover_tracking_only:true,
  snapshot:{patient:{given_name:'Avery',family_name:'Synthetic',mrn:'SYN-MRN'},account,coordination_of_benefits:{
   primary_coverage:{payer:{content:{name:'Synthetic Primary'}}},
   adjudication:{paid_cents:8000,patient_responsibility_cents:2000,payer_control_number:'SYN-PRIMARY-1'},
   payment_date:'2026-11-01',trace:'SYN-TRACE-1',crossover_reference:'SYN-CROSS-1',
   crossover:{remittance_id:'era',payment_date:'2026-11-05',trace:'SYN-TRACE-2',payee_npi:'1234567893',claim:{paid_cents:1200}}}}});
 assert.doesNotMatch(crossed.nodes['claims-detail'].innerHTML,/Why it came back/,'a crossover response is not offered a fix and resend');
 await crossed.context.beginClaimFix('claim','member_id');
 assert.deepEqual(crossed.chartSections,[],'the insurance is not opened for a claim we never sent');
 assert.match(crossed.notices.join(' '),/forwarded by the primary payer/i,'and the screen says why there is nothing to fix');

 // 9. Nothing in the fix flow may refuse staff outright.
 const claims=fs.readFileSync('web/claims.js','utf8');
 const flow=claims.slice(claims.indexOf('async function beginClaimFix'),claims.indexOf('async function reviewExistingClaimSubmission'));
 assert.ok(flow.length>500,'the fix flow was found');
 assert.doesNotMatch(flow,/throw new Error/,'the fix flow warns instead of stopping staff');

 console.log('PASS a claim that came back explains itself at the top of the claim screen and one button opens the right fix without stopping staff');
})().catch(error=>{console.error(error);process.exitCode=1;});
