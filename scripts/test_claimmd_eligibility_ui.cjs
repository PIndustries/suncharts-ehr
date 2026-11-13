// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic UI fixtures; a live Claim.MD account and browser acceptance are separate checks.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../web/claimmd-eligibility.js'),'utf8');
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const tick=async(times=6)=>{for(let i=0;i<times;i++)await new Promise(resolve=>setImmediate(resolve));};
const text=html=>html.replace(/<[^>]*>/g,' ');
// Words that belong to the wire format, not to the front desk.
const technical=/structured real-time|benefit type codes|administrative sex|diagnostic|HTTP ?\d|No diagnostic code|review the saved|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|provider_rejected|\bnull\b|undefined|\{"/i;
const TODAY=new Date().toISOString().slice(0,10),daysAgo=days=>new Date(Date.now()-days*86400000).toISOString();
const ids={check:'5b1f0c1e-7c1d-4b1a-9d43-0a1b2c3d4e5f',actor:'9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',coverage:'coverage-1'};

function setup(options={}){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',dataset:{}});return nodes.get(id);};
 const handlers={},calls=[],notices=[],opened=[],histories=new Map(),support=new Map();
 const coverage={id:ids.coverage,version:3,content:{status:'active',relationship:'self',payer_id:'payer-1',member_id:'SYN-MEMBER',copay_cents:null,priority:'primary',...options.coverage}};
 let sequence=0,pending=Promise.resolve();
 const c=vm.createContext({console,Date,Intl,URLSearchParams,JSON,selected:'patient-1',me:{role:options.role||'owner',user_id:'user-1'},chartSection:'insurance',activeVisit:null,
  workspace:{patient:{given_name:'Synthetic',family_name:'Patient',birth_date:'1980-01-01'},billing:{coverages:[coverage]}},
  billingPayers:[{id:'payer-1',content:{name:'Synthetic Health',payer_code:options.payerCode??'SYN'}}],
  crypto:{randomUUID:()=>`request-${++sequence}`},document:{addEventListener:(kind,handler)=>{handlers[kind]=handler;}},window:{open:(...args)=>opened.push(args)},
  FormData:class{constructor(form){return Object.entries(form.values);}},
  $:node,esc,human:value=>String(value).replaceAll('_',' '),date:value=>`at ${value}`,billingWrite:()=>!['read_only','nurse'].includes(c.me.role),billingCan:()=>true,payerName:()=> 'Synthetic Health',
  notice:(message,error)=>notices.push([message,!!error]),run:action=>{pending=Promise.resolve().then(action).catch(error=>{notices.push([error.message,true]);});},
  api:async(url,method='GET',body,version)=>{calls.push({url,method,body,version});return c.respond(url,method,body);},
  respond:(url,method)=>method==='GET'?{items:histories.get(ids.coverage)||[]}:{outcome:'skipped'},
  refreshInsuranceEligibility:id=>{node('insurance-eligibility-'+id).innerHTML=c.claimmdEligibilityCard(c.workspace.billing.coverages.find(item=>item.id===id),histories.get(id)||[],{serviceDate:TODAY});},
  updateInsuranceEligibility:(id,history)=>{histories.set(id,history.items);c.refreshInsuranceEligibility(id);},
  revenueAppointment:()=>({id:'appointment-1'}),revenueServiceDate:()=>TODAY,
  selectPatient:async()=>{const saved=calls.filter(call=>call.method==='PUT').at(-1);if(saved)c.workspace.billing.coverages=[{...coverage,version:coverage.version+1,content:saved.body.content}];},showChartSection(){},
  supportHelpAvailable:()=>true,supportDrafts:support,openSupportFromHere:async()=>{calls.push({url:'support'});},showEdiWorkspace:async()=>{calls.push({url:'connections'});},showBillingQueue:async()=>{calls.push({url:'payers'});},payerEditor:payer=>calls.push({url:'payer-editor',body:payer.id})});
 vm.runInContext(source,c);
 const button=(dataset,attributes=[])=>({target:{closest:selector=>selector==='button'?{dataset,hasAttribute:name=>attributes.includes(name)}:null},preventDefault(){},stopImmediatePropagation(){}});
 const card=()=>node('insurance-eligibility-'+ids.coverage).innerHTML;
 return {c,coverage,calls,notices,opened,histories,support,handlers,node,card,posts:()=>calls.filter(call=>call.method==='POST'),
  click:async(dataset,attributes)=>{handlers.click(button(dataset,attributes));await pending;await tick();await pending;},
  submit:async(form)=>{handlers.submit({target:form,preventDefault(){},stopImmediatePropagation(){}});await pending;await tick();},
  show:(items,over={})=>c.claimmdEligibilityCard(c.workspace.billing.coverages[0],items,{serviceDate:TODAY,...over})};
}
const check=(over={})=>({id:ids.check,patient_id:'patient-1',coverage_id:ids.coverage,status:'completed',actor_id:ids.actor,actor_name:'Synthetic Owner',created_at:'2026-11-13T15:00:00Z',completed_at:'2026-11-13T15:00:02Z',
 request_snapshot:{request:{service_date:TODAY,insured_given_name:'Synthetic',insured_family_name:'Patient',insured_birth_date:'1980-01-01',provider_id:'provider-1'},member_id:'SYN-MEMBER',provider_name:'Dr. Synthetic Provider',payerid:'SYN',automatic:false},...over});
const failed=(failure,over={})=>check({status:'failed',response_snapshot:failure===undefined?undefined:{failure},...over});
const benefit=(code,kind,more={})=>({benefit_code:code,benefit_coverage_code:kind,...more});
// Modelled on the structure Claim.MD documents for its eligibility response.
const plan=(benefits,more={})=>({elig:[{ins_name_f:'SYNTHETIC',ins_name_l:'PATIENT',ins_dob:'19800101',ins_number:'SYN-MEMBER',group_number:'GRP-77',plan_number:'PLN-1',plan_begin_date:'20260101-20261231',benefit:benefits,...more}]});
const rich=plan([
 benefit('30','1',{benefit_coverage_description:'Active Coverage',benefit_description:'Health Benefit Plan Coverage',insurance_plan:'Synthetic Gold PPO <b>',insurance_type_description:'Preferred Provider Organization (PPO)'}),
 benefit('98','B',{benefit_coverage_description:'Co-Payment',benefit_description:'Professional (Physician) Visit - Office',benefit_amount:'15',inplan_network:'Y',benefit_period_code:'27'}),
 benefit('98','B',{benefit_coverage_description:'Co-Payment',benefit_description:'Professional (Physician) Visit - Office',benefit_amount:'60',inplan_network:'N'}),
 benefit('96','B',{benefit_coverage_description:'Co-Payment',benefit_description:'Professional (Physician)',benefit_amount:'40',inplan_network:'Y'}),
 benefit('30','A',{benefit_coverage_description:'Co-Insurance',benefit_description:'Health Benefit Plan Coverage',benefit_percent:'20',inplan_network:'Y'}),
 benefit('30','A',{benefit_coverage_description:'Co-Insurance',benefit_description:'Health Benefit Plan Coverage',benefit_percent:'40',inplan_network:'N'}),
 benefit('30','C',{benefit_coverage_description:'Deductible',benefit_description:'Health Benefit Plan Coverage',benefit_amount:'6000',benefit_level_code:'FAM',benefit_period_code:'23',inplan_network:'Y'}),
 benefit('30','C',{benefit_coverage_description:'Deductible',benefit_description:'Health Benefit Plan Coverage',benefit_amount:'3000',benefit_level_code:'IND',benefit_period_code:'23',inplan_network:'Y'}),
 benefit('30','C',{benefit_coverage_description:'Deductible',benefit_description:'Health Benefit Plan Coverage',benefit_amount:'1500',benefit_level_code:'IND',benefit_period_code:'29',inplan_network:'Y'}),
 benefit('30','C',{benefit_coverage_description:'Deductible',benefit_description:'Health Benefit Plan Coverage',benefit_amount:'9000',benefit_level_code:'IND',benefit_period_code:'23',inplan_network:'N'}),
 benefit('30','G',{benefit_coverage_description:'Out of Pocket (Stop Loss)',benefit_description:'Health Benefit Plan Coverage',benefit_amount:'6500',benefit_level_code:'IND',benefit_period_code:'23',inplan_network:'Y'}),
 benefit('30','G',{benefit_coverage_description:'Out of Pocket (Stop Loss)',benefit_description:'Health Benefit Plan Coverage',benefit_amount:'4200',benefit_level_code:'IND',benefit_period_code:'29',inplan_network:'Y'}),
 benefit('30','G',{benefit_coverage_description:'Out of Pocket (Stop Loss)',benefit_description:'Health Benefit Plan Coverage',benefit_amount:'8800',benefit_level_code:'FAM',benefit_period_code:'29',inplan_network:'Y'}),
 benefit('98','F',{benefit_coverage_description:'Limitations',benefit_description:'Professional (Physician) Visit - Office',inplan_network:'Y',benefit_notes:'20 visits per year <script>'})
]);

(async()=>{
 // ---- Existing payer directory behaviour -------------------------------------------------
 const base=setup();
 assert.match(base.c.claimmdEligibilityButton({id:'coverage-1',content:{status:'active'}}),/data-claimmd-eligibility="coverage-1"/);
 assert.equal(base.c.claimmdEligibilityButton({id:'coverage-2',content:{status:'inactive'}}),'');
 assert.doesNotMatch(source,/AccountKey|account_key/);
 const payerHtml=base.c.claimmdPayerRows([{payer_name:'Payer <script>',payerid:'60054',payer_type:'commercial',eligibility:'yes','1500_claims':'yes',ub_claims:'no',era:'enrollment'}]);
 assert.match(payerHtml,/Payer &lt;script&gt;/);assert.doesNotMatch(payerHtml,/<script>/);assert.match(payerHtml,/60054/);
 assert.match(base.c.claimmdPayerRows([{payer_name:'Synthetic payer',payerid:'SYN001'}],true),/data-claimmd-payer-select="SYN001"/);
 assert.match(base.c.claimmdCoveragePayerSearch(),/coverage-claimmd-payer-search/);
 vm.runInContext("claimmdProviderDefaults={providers:[{id:'provider-1',display_name:'Synthetic Provider',npi:'1234567893'}],facilities:[{id:'facility-1',name:'Synthetic Clinic',address:'100 Test Way'}],default_provider_id:'provider-1',default_facility_id:'facility-1'}",base.c);
 assert.deepEqual(JSON.parse(JSON.stringify(base.c.claimmdClaimProviderDefaults())),{billing_provider_name:'Synthetic Clinic',billing_npi:'1234567893',rendering_npi:'1234567893',billing_address:'100 Test Way',tax_id:''});
 console.log('PASS payer directory, claim defaults and no credential fields in browser source');

 // ---- One click, no form ---------------------------------------------------------------------
 {
  const t=setup();let release;
  t.c.respond=(url,method)=>method==='GET'?{items:t.answered?[check({response_snapshot:rich})]:[]}:new Promise(resolve=>{release=()=>{t.answered=true;resolve({outcome:'checked',check:check({response_snapshot:rich})});};});
  t.c.refreshInsuranceEligibility(ids.coverage);
  assert.match(t.card(),/Not checked with the insurer yet/);
  const clicking=t.click({claimmdEligibility:ids.coverage});await tick();
  assert.match(t.card(),/Checking with Synthetic Health…/,'the card says what is happening while the insurer answers');
  assert.doesNotMatch(t.card(),/<form|<input|<select/,'no form is shown for a check');
  const [post]=t.posts();assert.equal(post.url,`/api/v1/patients/patient-1/coverages/${ids.coverage}/claimmd-eligibility/check`);
  assert.deepEqual(JSON.parse(JSON.stringify(post.body)),{request_id:'request-1',automatic:false,appointment_id:'appointment-1',service_date:TODAY},'the browser sends the click and the visit, never subscriber or provider fields');
  release();await clicking;await tick();
  assert.match(t.card(),/eligibility-pill active">Active</);assert.doesNotMatch(t.card(),/Checking with/);
  assert.equal(t.posts().length,1);assert.equal(t.node('billing-editor').innerHTML,'','nothing opens in the editor');
  console.log('PASS one click checks in place with a short progress line and no form');
 }

 // ---- Asking for exactly one thing -------------------------------------------------------------
 {
  const t=setup();const replies=[{outcome:'needs',insurer:'Synthetic Health',needs:[{kind:'billing_organization',choices:[{id:'org-1',name:'Synthetic <One>',tax_id_type:'E',tax_id_last4:'0017'},{id:'org-2',name:'Synthetic Two',tax_id_type:'S',tax_id_last4:'0028'}]},{kind:'provider',choices:[{id:'provider-1',display_name:'Dr. One'},{id:'provider-2',display_name:'Dr. Two'}]}]},{outcome:'checked',check:check({response_snapshot:rich})}];
  t.c.respond=(url,method)=>method==='GET'?{items:[]}:replies.shift();
  await t.click({claimmdEligibility:ids.coverage});
  const prompt=t.card();
  assert.match(prompt,/Which billing organization should Synthetic Health see\?/);assert.match(prompt,/Synthetic &lt;One&gt; · EIN ending 0017/);assert.match(prompt,/Synthetic Two · SSN ending 0028/);
  assert.equal((prompt.match(/<form/g)||[]).length,1,'one question at a time');assert.doesNotMatch(prompt,/Which provider/);assert.equal((prompt.match(/<select|<input/g)||[]).length,1);
  await t.submit({dataset:{eligibilityNeed:'billing_organization',coverage:ids.coverage},values:{billing_organization_id:'org-2'}});
  const second=t.posts()[1];assert.equal(second.body.billing_organization_id,'org-2');assert.notEqual(second.body.request_id,t.posts()[0].body.request_id,'an answered question is a new request');
  assert.doesNotMatch(t.card(),/<form/);
  const dependent=setup({coverage:{relationship:'child',subscriber_name:'Parent Synthetic'}});const answers=[{outcome:'needs',insurer:'Synthetic Health',needs:[{kind:'subscriber_birth_date'}]},{outcome:'checked',check:check({response_snapshot:rich})}];
  dependent.c.respond=(url,method)=>method==='GET'?{items:[]}:method==='PUT'?{}:answers.shift();
  await dependent.click({claimmdEligibility:ids.coverage});
  assert.match(dependent.card(),/What is the policy holder's date of birth\?/);assert.match(dependent.card(),/type="date" name="subscriber_birth_date" required/);
  await dependent.submit({dataset:{eligibilityNeed:'subscriber_birth_date',coverage:ids.coverage},values:{subscriber_birth_date:'1955-02-03'}});
  const saved=dependent.calls.find(call=>call.method==='PUT');assert.equal(saved.url,`/api/v1/patients/patient-1/coverages/${ids.coverage}`);assert.equal(saved.version,3);assert.equal(saved.body.content.subscriber_birth_date,'1955-02-03');assert.equal(saved.body.content.member_id,'SYN-MEMBER');assert.match(saved.body.reason,/date of birth/);
  assert.equal(dependent.posts().length,2,'the check runs again once the missing date is on the coverage');
  for(const [need,words,ownerAction,staffWords] of [[{kind:'payer_id',payer_id:'payer-1'},/This insurance company has no payer ID yet\./,/data-eligibility-payer="payer-1"/,/Ask the practice owner to add it/],[{kind:'provider_npi'},/No provider has an NPI on file yet\./,/data-practice-providers/,/Ask the practice owner/],[{kind:'billing_organization_missing'},/no billing organization with a tax ID yet/,/data-billing-organizations/,/Ask the practice owner/],[{kind:'claim_connection'},/Claim\.MD is not connected\./,/data-eligibility-connections/,/Ask the practice owner to check Claim connections/],[{kind:'member_id'},/This coverage has no member ID\./,/data-edit-coverage/,/data-edit-coverage/],[{kind:'subscriber_name'},/Policy holder's first name/,/name="family"/,/name="family"/]]){
   for(const role of ['owner','front_desk']){const n=setup({role});n.c.respond=(url,method)=>method==='GET'?{items:[]}:{outcome:'needs',insurer:'Synthetic Health',needs:[need]};await n.click({claimmdEligibility:ids.coverage});assert.match(n.card(),words,need.kind);assert.match(n.card(),role==='owner'?ownerAction:staffWords,`${need.kind} ${role}`);assert.doesNotMatch(text(n.card()),technical);}
  }
  const payer=setup();payer.c.respond=(url,method)=>method==='GET'?{items:[]}:{outcome:'needs',needs:[{kind:'payer_id',payer_id:'payer-1'}]};await payer.click({claimmdEligibility:ids.coverage});await payer.click({eligibilityPayer:'payer-1'});assert.deepEqual(payer.calls.slice(-2).map(call=>call.url),['payers','payer-editor'],'the button opens the place the payer ID is set');
  console.log('PASS a missing detail is asked for once, by itself, with a choice where a list exists');
 }

 // ---- A click is never sent twice ---------------------------------------------------------------
 {
  const t=setup();let attempt=0;
  t.c.respond=(url,method)=>{if(method==='GET')return {items:[]};attempt++;if(attempt===1)throw new Error('Connection interrupted. This change may have saved. Reload the patient before trying again.');if(attempt===2)throw Object.assign(new Error('Too many requests were sent to Claim.MD in the last minute. Wait a minute, then try again.'),{status:400});return {outcome:'checked',check:check({response_snapshot:rich})};};
  await t.click({claimmdEligibility:ids.coverage});assert.match(t.card(),/Connection interrupted/);
  await t.click({claimmdEligibility:ids.coverage});assert.equal(t.posts()[1].body.request_id,t.posts()[0].body.request_id,'an unanswered click keeps its request ID');assert.match(t.card(),/Wait a minute, then try again/);
  await t.click({claimmdEligibility:ids.coverage});assert.notEqual(t.posts()[2].body.request_id,t.posts()[1].body.request_id,'a refused click is finished');
  let hold;t.c.respond=(url,method)=>method==='GET'?{items:[]}:new Promise(resolve=>{hold=resolve;});
  const running=t.click({claimmdEligibility:ids.coverage});await tick();await t.click({claimmdEligibility:ids.coverage});assert.equal(t.posts().length,4,'a second click while checking does nothing');hold({outcome:'skipped'});await running;
  console.log('PASS interrupted clicks reuse their request ID and a running check ignores further clicks');
 }

 // ---- Automatic check ------------------------------------------------------------------------------
 {
  const context={appointmentId:'appointment-1',serviceDate:TODAY};
  const auto=async(items,over={},options={})=>{const t=setup(options);t.histories.set(ids.coverage,items);t.c.respond=(url,method)=>method==='GET'?{items}:{outcome:'skipped',reason:'recent_check'};const ran=t.c.claimmdEligibilityAuto(t.c.workspace.billing.coverages[0],items,{...context,...over});await tick();return {t,ran};};
  const first=await auto([]);assert.equal(first.ran,true);assert.equal(first.t.posts().length,1);assert.equal(first.t.posts()[0].body.automatic,true);assert.equal(first.t.posts()[0].body.appointment_id,'appointment-1');
  assert.equal(first.t.c.claimmdEligibilityAuto(first.t.c.workspace.billing.coverages[0],[],context),false);await tick();assert.equal(first.t.posts().length,1,'one automatic attempt per coverage for as long as the page is open');
  assert.equal(first.t.notices.length,0,'an automatic check never raises a banner');
  assert.equal((await auto([check({response_snapshot:rich,request_snapshot:{request:{service_date:daysAgo(10).slice(0,10)}}})])).ran,false,'a recent answer is not asked for again');
  assert.equal((await auto([check({response_snapshot:rich,request_snapshot:{request:{service_date:daysAgo(45).slice(0,10)}}})])).ran,true,'an answer older than 30 days is refreshed');
  assert.equal((await auto([failed({kind:'provider_rejected',http_status:200},{created_at:daysAgo(0.2)})])).ran,false,'a failure in the last 12 hours is not retried automatically');
  assert.equal((await auto([failed({kind:'provider_rejected',http_status:200},{created_at:daysAgo(2)})])).ran,true);
  assert.equal((await auto([check({status:'pending'})])).ran,false);
  assert.equal((await auto([],{},{coverage:{status:'inactive'}})).ran,false,'never for inactive coverage');
  assert.equal((await auto([],{},{coverage:{status:'entered_in_error'}})).ran,false);
  assert.equal((await auto([],{},{payerCode:''})).ran,false,'never without a payer ID');
  assert.equal((await auto([],{appointmentId:undefined})).ran,false,'never without an appointment in view');
  assert.equal((await auto([],{},{role:'read_only'})).ran,false);
  const quiet=setup();quiet.c.respond=(url,method)=>method==='GET'?{items:[]}:{outcome:'needs',insurer:'Synthetic Health',needs:[{kind:'billing_organization',choices:[]}]};quiet.c.claimmdEligibilityAuto(quiet.coverage,[],context);await tick();
  assert.doesNotMatch(quiet.card(),/<form/,'a question is only asked after a click');assert.match(quiet.card(),/Not checked with the insurer yet/);
  const failing=setup();failing.c.respond=(url,method)=>{if(method==='GET')return {items:[]};throw Object.assign(new Error('Synthetic server refusal'),{status:400});};failing.c.claimmdEligibilityAuto(failing.coverage,[],context);await tick();assert.doesNotMatch(failing.card(),/Synthetic server refusal/);assert.equal(failing.posts().length,1,'a refused automatic check is not repeated');
  const shown=setup().show([check({response_snapshot:rich,request_snapshot:{...check().request_snapshot,automatic:true}})]);assert.match(shown,/Checked automatically at 2026-11-13T15:00:02Z/);assert.doesNotMatch(shown,/by Synthetic Owner/);
  console.log('PASS automatic check runs once, only when a fresh answer is worth it, and stays quiet');
 }

 // ---- The summary ------------------------------------------------------------------------------------
 {
  const t=setup({role:'front_desk'}),html=t.show([check({response_snapshot:rich})]),plain=text(html);
  assert.match(html,/<span class="eligibility-pill active">Active<\/span>/);
  assert.ok(plain.includes(`on ${t.c.claimmdDay(TODAY)} · Checked at 2026-11-13T15:00:02Z by Synthetic Owner`),plain.slice(0,200));
  for(const shown of ['Synthetic Gold PPO &lt;b&gt;','Preferred Provider Organization (PPO)','GRP-77','Jan 1, 2026 – Dec 31, 2026','SYNTHETIC PATIENT','What the patient pays at a visit','<dt>Office visit copay</dt><dd>$15.00</dd>','<dt>Coinsurance</dt><dd>20%</dd>','<dt>Deductible</dt><dd>$1,500.00 left of $3,000.00</dd>','<dt>Out-of-pocket limit</dt><dd>$4,200.00 left of $6,500.00</dd>','<summary>Out of network</summary>','<summary>See all benefits</summary>','20 visits per year &lt;script&gt;','Limitations'])assert.ok(html.includes(shown),shown);
  const outOfNetwork=html.slice(html.indexOf('<summary>Out of network</summary>'),html.indexOf('This is what the insurer reported'));
  for(const shown of ['<dd>$60.00</dd>','<dd>40%</dd>','<dd>$9,000.00</dd>','<dt>Out-of-pocket limit</dt><dd>Not reported by the insurer</dd>'])assert.ok(outOfNetwork.includes(shown),shown);
  const beforeDetails=html.slice(0,html.indexOf('<summary>See all benefits</summary>')),details=html.slice(html.indexOf('<summary>See all benefits</summary>'));
  for(const family of ['$6,000.00','$8,800.00']){assert.ok(!beforeDetails.includes(family),'family amounts stay in the details');assert.ok(details.includes(family));}
  assert.match(details,/<h5>Health Benefit Plan Coverage<\/h5>/);assert.match(details,/<p class="muted">In network<\/p>/);assert.match(details,/<p class="muted">Out of network<\/p>/);assert.match(details,/Family · calendar year/);
  assert.doesNotMatch(html,/<script>|PPO <b>|different .* on file|Technical details|data-eligibility-advanced|More options/,'staff view: escaped, no mismatch, no technical details, no full form');
  assert.doesNotMatch(plain,technical);assert.doesNotMatch(plain,new RegExp(ids.actor));
  assert.match(html,/data-eligibility-copay="coverage-1" data-cents="1500"[^>]*>Save \$15\.00 as this plan's copay</);
  assert.doesNotMatch(setup({coverage:{copay_cents:1500}}).show([check({response_snapshot:rich})]),/data-eligibility-copay/,'nothing to save when the plan already records this copay');
  assert.match(setup({coverage:{copay_cents:2500}}).show([check({response_snapshot:rich})]),/Save \$15\.00 as this plan's copay/,'a different recorded copay can be replaced');
  assert.doesNotMatch(setup().show([check({response_snapshot:rich})],{readOnly:true}),/data-eligibility-copay|data-claimmd-eligibility|More options/);
  const owner=setup().show([check({response_snapshot:rich})]);
  assert.match(owner,/<details class="eligibility-technical"><summary>Technical details<\/summary>/);assert.match(owner,/<details class="eligibility-more eligibility-options"><summary>More options<\/summary>/);assert.match(owner,/data-eligibility-advanced="coverage-1"/);
  assert.doesNotMatch(text(owner.replace(/<details class="eligibility-technical">.*?<\/details>/gs,'')),technical,'owner view is plain outside the collapsed technical details');
  assert.doesNotMatch(owner,/<details[^>]* open/,'details start collapsed');
  const specialist=setup().show([check({response_snapshot:plan([benefit('30','1'),benefit('96','B',{benefit_amount:'40',inplan_network:'Y'}),benefit('30','B',{benefit_amount:'10',inplan_network:'Y'})])})]);assert.match(specialist,/<dt>Specialist visit copay<\/dt><dd>\$40\.00<\/dd>/,'specialist copay when no office visit copay is reported');
  const planLevel=setup().show([check({response_snapshot:plan([benefit('30','1'),benefit('30','B',{benefit_amount:'0',inplan_network:'W'})])})]);assert.match(planLevel,/<dt>Copay<\/dt><dd>\$0\.00<\/dd>/,'plan-level copay last, and a zero copay is a real answer');assert.match(planLevel,/Save \$0\.00 as this plan's copay/);
  const bare=setup().show([check({response_snapshot:plan([benefit('30','1')],{group_number:'',plan_begin_date:''})})]);for(const label of ['Office visit copay','Coinsurance','Deductible','Out-of-pocket limit'])assert.ok(bare.includes(`<dt>${label==='Office visit copay'?'Copay':label}</dt><dd>Not reported by the insurer</dd>`),label);assert.doesNotMatch(bare,/Group number|Coverage dates|data-eligibility-copay/);
  assert.equal(setup().c.claimmdBenefitValue({benefit_percent:'0.5'}),'0.5%','percentages are already percent units');assert.equal(setup().c.claimmdBenefitValue({benefit_amount:'malformed',benefit_percent:'101'}),'');
  const otherDate=setup().show([check({response_snapshot:rich,request_snapshot:{...check().request_snapshot,request:{...check().request_snapshot.request,service_date:'2026-10-01'}}})]);assert.match(otherDate,/This answer is for Oct 1, 2026\. The visit is on /);
  console.log('PASS active plan summary: status, plan, what the patient pays in network first, family and limits in details');
 }
 {
  const inactive=setup().show([check({response_snapshot:plan([benefit('30','6',{benefit_coverage_description:'Inactive',insurance_plan:'Synthetic Old Plan'}),benefit('98','B',{benefit_amount:'15',inplan_network:'Y'})])})]);
  assert.match(inactive,/<span class="eligibility-pill inactive">Not active<\/span>/);assert.match(inactive,/not active on this date\. Ask the patient for their current insurance card/);assert.match(inactive,/Synthetic Old Plan/);assert.doesNotMatch(inactive,/What the patient pays|data-eligibility-copay/);
  const notFound=setup({role:'front_desk'}).show([check({response_snapshot:{elig:[{error:[{error_code:'75',error_message:'Subscriber/Insured Not Found'}]}]}})]);
  assert.match(notFound,/<span class="eligibility-pill unknown">Could not confirm<\/span>/);assert.match(notFound,/The insurer could not find this member\. Check the member ID, name and date of birth on the coverage\./);assert.match(notFound,/data-edit-coverage="coverage-1"/);assert.doesNotMatch(notFound,/What the patient pays/);assert.doesNotMatch(text(notFound),technical);
  const busy=setup().show([check({response_snapshot:{elig:[{error:{error_code:'42',error_message:'Unable to Respond at Current Time'}}]}})]);assert.match(busy,/could not answer right now\. Try again in a few minutes/);assert.match(busy,/data-claimmd-eligibility="coverage-1">Try again/);
  const unknownProvider=setup().show([check({response_snapshot:{elig:[{error:[{error_code:'51',error_message:'Provider Not on File'}]}]}})]);assert.match(unknownProvider,/The insurer does not recognise Dr\. Synthetic Provider for eligibility checks yet\./);assert.match(unknownProvider,/Set up eligibility with Claim\.MD/);
  const worded=setup().show([check({response_snapshot:{elig:[{error:[{error_code:'33',error_message:'Input <Errors>'}]}]}})]);assert.match(worded,/The insurer did not confirm coverage: “Input &lt;Errors&gt;”/);
  const silent=setup().show([check({response_snapshot:{elig:[{ins_name_l:'PATIENT'}]}})]);assert.match(silent,/Could not confirm/);assert.match(silent,/did not say whether the plan is active/);
  const mismatch=html=>/<p class="eligibility-caution">([^<]*)<\/p>/.exec(html)?.[1];
  assert.equal(mismatch(setup().show([check({response_snapshot:plan([benefit('30','1')],{ins_dob:'19800202'})})])),'The insurer has a different date of birth on file.');
  assert.equal(mismatch(setup().show([check({response_snapshot:plan([benefit('30','1')],{ins_name_l:'PATIENTE',ins_number:'SYN-OTHER'})})])),'The insurer has a different name and member ID on file.');
  assert.equal(mismatch(setup().show([check({response_snapshot:plan([benefit('30','1')],{ins_name_f:'synthetic',ins_name_l:"Patient",ins_number:'syn member',ins_dob:'1980-01-01'})})])),undefined,'case, spacing and punctuation are not a mismatch');
  console.log('PASS inactive coverage, insurer refusals and name, date of birth and member ID differences');
 }

 // ---- Saving the copay ---------------------------------------------------------------------------------
 {
  const t=setup({role:'front_desk'});t.histories.set(ids.coverage,[check({response_snapshot:rich})]);t.c.respond=(url,method)=>method==='GET'?{items:t.histories.get(ids.coverage)}:{};
  t.c.refreshInsuranceEligibility(ids.coverage);assert.equal(t.calls.length,0,'showing the answer never saves anything');
  await t.click({eligibilityCopay:ids.coverage,cents:'1500',checkDate:TODAY});
  const saved=t.calls.find(call=>call.method==='PUT');assert.equal(saved.version,3,'the coverage version is sent');assert.equal(saved.body.content.copay_cents,1500);assert.equal(saved.body.content.member_id,'SYN-MEMBER','the rest of the coverage is unchanged');assert.equal(saved.body.reason,`From the insurer's eligibility response ${TODAY}`);
  assert.match(t.card(),/<p class="eligibility-saved" role="status">Saved\. This plan's copay is now \$15\.00\.<\/p>/);assert.doesNotMatch(t.card(),/data-eligibility-copay/);assert.deepEqual(t.notices.at(-1),["Saved $15.00 as this plan's copay.",false]);
  console.log('PASS the returned copay is saved only on a click, with the coverage version and a reason, and confirmed in place');
 }

 // ---- Failures in plain words -----------------------------------------------------------------------------
 {
  const view=(failure,role='owner',over)=>setup({role}).show([failed(failure,over)]);
  const enroll=view({kind:'provider_rejected',http_status:200,provider_codes:[],provider_hints:['eligibility','provider']});
  assert.match(enroll,/Claim\.MD has not turned on eligibility checks for Dr\. Synthetic Provider with Synthetic Health yet\./);assert.match(enroll,/data-eligibility-enroll="5b1f0c1e-7c1d-4b1a-9d43-0a1b2c3d4e5f" data-coverage="coverage-1">Set up eligibility with Claim\.MD</);assert.match(enroll,/This does not mean the patient is uninsured/);assert.match(enroll,/Tried at 2026-11-13T15:00:02Z by Synthetic Owner/);
  const staffEnroll=view({kind:'provider_rejected',http_status:200,provider_hints:['eligibility','provider']},'front_desk');
  assert.match(staffEnroll,/Ask the practice owner to set this up under Claim connections\./);assert.doesNotMatch(staffEnroll,/data-eligibility-enroll|Technical details/);
  for(const hints of [['member'],['subscriber','not found'],['name','invalid'],['birth','date']]){const html=view({kind:'provider_rejected',http_status:200,provider_hints:hints},'front_desk');assert.match(html,/The insurer could not find this member\. Check the member ID, name and date of birth on the coverage\./,hints.join());assert.match(html,/data-edit-coverage="coverage-1">Edit coverage</);}
  const payer=view({kind:'provider_rejected',http_status:200,provider_hints:['payer','invalid']});assert.match(payer,/did not recognise the payer ID for Synthetic Health/);assert.match(payer,/data-eligibility-payer="payer-1">Add the payer ID</);assert.match(view({kind:'provider_rejected',http_status:200,provider_hints:['payer']},'front_desk'),/Ask the practice owner to add it in the payer directory/);
  for(const failure of [{kind:'transport_unavailable',http_status:null},{kind:'http_rejected',http_status:503},{kind:'http_rejected',http_status:429},{kind:'response_invalid',http_status:200},{kind:'provider_rejected',http_status:200,provider_hints:['timeout']}]){const html=view(failure,'front_desk');assert.match(html,/The insurer's system did not answer\. Try again in a few minutes\./,JSON.stringify(failure));assert.match(html,/data-claimmd-eligibility="coverage-1">Try again</);}
  for(const failure of [{kind:'configuration_unavailable',http_status:null},{kind:'http_rejected',http_status:401},{kind:'provider_rejected',http_status:200,provider_hints:['account','key']}]){assert.match(view(failure),/Claim\.MD is not connected\..*data-eligibility-connections>Open Claim connections</,JSON.stringify(failure));assert.match(view(failure,'front_desk'),/Claim\.MD is not connected\..*Ask the practice owner to check Claim connections\./);}
  for(const failure of [{kind:'provider_rejected',http_status:200,provider_codes:['42']},{kind:'provider_rejected',http_status:200,provider_hints:['required','missing']},undefined]){const html=view(failure,'front_desk');assert.match(html,/Claim\.MD refused the request and gave no reason we can show\. Send this to support\./);assert.match(html,/data-eligibility-support="5b1f0c1e-7c1d-4b1a-9d43-0a1b2c3d4e5f" data-coverage="coverage-1">Send this to support</);}
  for(const role of ['owner','front_desk'])for(const failure of [{kind:'provider_rejected',http_status:200,provider_codes:['42','<x>'],provider_hints:['eligibility','provider','<unsafe>']},{kind:'http_rejected',http_status:500},{kind:'provider_rejected',http_status:200},undefined]){
   const html=view(failure,role),normal=text(html.replace(/<details class="eligibility-technical">.*?<\/details>/gs,''));
   assert.doesNotMatch(normal,technical,`${role} ${JSON.stringify(failure)}`);assert.doesNotMatch(normal,/HTTP|code 42|unsafe/i);assert.doesNotMatch(html,/<unsafe>|<x>/);
   assert.equal(/Technical details/.test(html),role==='owner'&&!!failure,'codes are kept behind Technical details for the owner');
  }
  assert.match(view({kind:'provider_rejected',http_status:200,provider_hints:['eligibility','provider']},'owner',{actor_name:null}),/Tried at 2026-11-13T15:00:02Z by a staff member/,'an unknown account never shows as an ID');
  const offline=setup({role:'front_desk'});offline.c.supportHelpAvailable=()=>false;const noSupport=offline.show([failed({kind:'provider_rejected',http_status:200,provider_codes:['42']})]);assert.match(noSupport,/Contact SunCharts support and tell them when this check was tried\./);assert.doesNotMatch(noSupport,/data-eligibility-support|Send this to support/,'no dead button when support requests are not available');
  console.log('PASS each failure says what happened and offers one next step; setup with Claim.MD is offered to the owner only');
 }

 // ---- Setting up eligibility with Claim.MD ------------------------------------------------------------------
 {
  const refusal=failed({kind:'provider_rejected',http_status:200,provider_hints:['eligibility','provider']});
  const start=async reply=>{const t=setup();t.histories.set(ids.coverage,[refusal]);t.c.respond=(url,method)=>method==='GET'?{items:[refusal]}:reply;t.c.refreshInsuranceEligibility(ids.coverage);await t.click({eligibilityEnroll:ids.check,coverage:ids.coverage});return t;};
  const started=await start({status:'started',external_url:'https://www.claim.md/enroll/synthetic/'});
  assert.deepEqual(JSON.parse(JSON.stringify(started.posts()[0])),{url:`/api/v1/patients/patient-1/coverages/${ids.coverage}/claimmd-eligibility/enrollment`,method:'POST',body:{check_id:ids.check}},'the browser names the check; the server supplies the tax ID, NPI and payer');
  assert.deepEqual(started.opened,[['https://www.claim.md/enroll/synthetic/','_blank','noopener,noreferrer']]);assert.match(started.card(),/setup form opened in a new tab\..*<a href="https:\/\/www\.claim\.md\/enroll\/synthetic\/" target="_blank" rel="noopener noreferrer">Open the form again<\/a>/);
  const elsewhere=await start({status:'started',external_url:'https://example.test/enroll'});assert.equal(elsewhere.opened.length,0,'only a Claim.MD address is opened');
  const already=await start({status:'refused',failure:{kind:'provider_rejected',provider_hints:['already','enroll']}});assert.equal(already.opened.length,0);assert.match(already.card(),/Claim\.MD says this is already set up or already requested\./);
  for(const reply of [{status:'no_link'},{status:'refused',failure:{kind:'provider_rejected',provider_hints:['invalid']}}]){const t=await start(reply);assert.match(t.card(),/Claim\.MD did not open a setup form for this insurer\. Sign in to Claim\.MD and open Provider Enrollment, or send this to support\./);assert.match(t.card(),/data-eligibility-support/);assert.doesNotMatch(text(t.card().replace(/<details class="eligibility-technical">.*?<\/details>/gs,'')),technical);}
  const help=setup({role:'front_desk'}),unexplained=failed({kind:'provider_rejected',http_status:200,provider_codes:['42'],provider_hints:['required']});help.histories.set(ids.coverage,[unexplained]);help.c.eligibilityState=()=>({items:new Map([[ids.coverage,{history:{items:[unexplained]}}]])});
  await help.click({eligibilitySupport:ids.check,coverage:ids.coverage});
  const draft=help.support.get('new');assert.equal(draft.subject,'Eligibility check was refused');for(const line of ['Checked: 2026-11-13T15:00:00.000Z','Claim.MD code: 42','Words in Claim.MD\'s reply: required',`Check reference: ${ids.check}`,'Synthetic Health'])assert.ok(draft.message.includes(line),line);
  assert.doesNotMatch(draft.message,/Synthetic Patient|SYN-MEMBER|1980/,'the ticket text carries no patient details; the chart is attached by the support form');assert.equal(help.calls.at(-1).url,'support');
  const connections=setup();await connections.click({},['data-eligibility-connections']);assert.equal(connections.calls.at(-1).url,'connections');
  console.log('PASS Claim.MD eligibility setup opens its form, explains refusals, and support requests carry the check time and codes');
 }

 // ---- History --------------------------------------------------------------------------------------------------
 {
  const older=check({id:'older',created_at:'2026-10-01T15:00:00Z',completed_at:'2026-10-01T15:00:01Z',response_snapshot:plan([benefit('30','6')]),actor_name:'Synthetic Biller'});
  const oldFailure=failed({kind:'http_rejected',http_status:500},{id:'old-failure',created_at:'2026-09-01T15:00:00Z',completed_at:'2026-09-01T15:00:01Z'});
  const newest=check({response_snapshot:rich});
  const html=setup().show([oldFailure,newest,older]);
  assert.ok(html.indexOf('eligibility-pill active')<html.indexOf('Past checks (2)'),'the newest answer is the summary');
  assert.match(html,/<details class="eligibility-past"><summary>at 2026-10-01T15:00:01Z · Not active · Synthetic Biller · for /);
  assert.match(html,/<details class="eligibility-attempts"><summary>Earlier attempts \(1\)<\/summary><details class="eligibility-past"><summary>at 2026-09-01T15:00:01Z · Could not confirm · Synthetic Owner/);
  const failedNow=setup().show([failed({kind:'transport_unavailable'},{id:'latest-failure',created_at:'2026-11-14T15:00:00Z',completed_at:'2026-11-14T15:00:01Z'}),newest]);
  assert.ok(failedNow.indexOf('did not answer')<failedNow.indexOf('Last answer from the insurer'),'a failed latest attempt is explained above the last answer');assert.match(failedNow,/Last answer from the insurer<\/p><div class="eligibility-result"><p class="eligibility-status"><span class="eligibility-pill active">/);assert.doesNotMatch(failedNow,/Past checks/);
  assert.match(setup().c.claimmdEligibilityRows(newest),/eligibility-pill active/);assert.doesNotMatch(setup().c.claimmdEligibilityRows(newest),/<button/,'the encounter summary is read-only');assert.equal(setup().c.claimmdEligibilityRows(oldFailure),'');
  console.log('PASS history: newest first, one line per check, earlier failed attempts folded away');
 }

 // ---- Dark mode ----------------------------------------------------------------------------------------------------
 {
  const css=fs.readFileSync(path.resolve(__dirname,'../web/style.css'),'utf8'),rules=css.match(/[^{}]*\{[^{}]*\}/g).filter(rule=>/eligibility-/.test(rule.split('{')[0]));
  assert.ok(rules.length>=20,'eligibility styles are present');
  for(const rule of rules)assert.doesNotMatch(rule.split('{')[1],/#[0-9a-f]{3,8}\b|rgb|hsl|\b(white|black)\b/i,`theme variables only: ${rule.slice(0,80)}`);
  for(const state of ['active','inactive','unknown'])assert.ok(rules.some(rule=>rule.includes(`.eligibility-pill.${state}{`)&&/background:var\(--[a-z-]+\);color:var\(--[a-z-]+\)/.test(rule)),state);
  const theme=fs.readFileSync(path.resolve(__dirname,'../web/theme.css'),'utf8');for(const name of ['--success-bg','--success-text','--warning-bg','--error-bg','--surface-soft','--surface-raised','--line','--muted','--ink','--blue'])assert.ok(theme.slice(theme.indexOf(':root[data-theme=dark]{')).includes(name+':'),`${name} has a dark value`);
  assert.doesNotMatch(source,/style="[^"]*(#[0-9a-f]{3,8}|rgb)/i,'no inline colours in the eligibility markup');
  console.log('PASS eligibility styles use theme variables only, so dark mode follows the theme');
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
