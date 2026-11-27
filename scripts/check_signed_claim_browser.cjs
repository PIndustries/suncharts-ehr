// SPDX-License-Identifier: AGPL-3.0-only
// Signed encounters before charges, ready to send, and after a response. All claim data is synthetic.
'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const puppeteer=require('puppeteer-core');
const {origin,id,staff,patient,appointment,visit,patientPath,fixture}=require('./check_encounter_scroll_browser.cjs');
const {visitSummary}=require('./visit_billing_fixture.cjs');

async function check(browser,viewport,variant){
 const ambiguous=variant==='several-groups',unmatched=variant==='unmatched-clinician';
 const context=await browser.createBrowserContext(),page=await context.newPage(),errors=[],writes=[];
 const signed={...visit,clinician_id:unmatched?id(606):staff.user_id,status:'signed',signed_at:appointment.ends_at,diagnoses:[]};
 const coverage={id:id(601),status:'active',version:1,content:{payer_id:'synthetic',plan_name:'Synthetic PPO',member_id:'SYN123',priority:'primary',relationship:'self',status:'active'}};
 const summary=visitSummary({visit:signed,patient_id:patient.id,account:null,claim:null,claim_count:0,state:'add_charges',balance_cents:null,charges_cents:null,
   receipts:[],insurance:{insured:true,insurer:'Synthetic PPO',coverage_id:coverage.id},patient:{owes_now_cents:null,received_cents:0,responsibility_cents:null,copay_cents:null}});
 const directory={providers:[{id:id(605),npi:'1245319599',display_name:'Other synthetic clinician'},
   {id:staff.user_id,npi:'1234567893',display_name:'Synthetic treating physician'}],
   facilities:[{id:id(602),name:'Synthetic facility',address:'100 Main Street, Trenton, NJ 08608'}],
   billing_organizations:[{id:id(603),name:'Synthetic billing practice',npi:''}]};
 if(ambiguous)directory.billing_organizations.push({id:id(604),name:'Second synthetic group',npi:'1123456798'});
 let directoryReads=0;
 try{
  await page.setViewport(viewport);page.setDefaultTimeout(12000);
  await page.setRequestInterception(true);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',request=>void (async()=>{
   const url=new URL(request.url()),path=url.pathname;
   if(url.origin!==origin)return request.abort();
   if(request.method()!=='GET'){writes.push(request.method()+' '+path);return request.abort();}
   let data;
   if(path===patientPath+'/billing')data={patient,coverages:[coverage],accounts:[],claims:[],entries:[],copays:[],diagnoses:[],summary};
   else if(path===patientPath+'/billing/visit-summary')data=summary;
   else if(path===patientPath+'/demographics')data={content:{address:'100 Main St',address_line1:'100 Main St',city:'Trenton',state:'NJ',postal_code:'08608'}};
   else if(path==='/api/v1/billing/claimmd/provider-defaults'){directoryReads++;data=directory;}
   else if(path.startsWith('/api/')||path.startsWith('/auth/'))data=fixture(path,signed,'blank',null,{});
   else if(/^\/$|\.(css|js|png|svg|webp|woff2?|ico)$/.test(path))return request.continue();
   else return request.abort();
   return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
  })().catch(async e=>{errors.push(e.message);if(!request.isInterceptResolutionHandled())await request.abort().catch(()=>{});}));
  await page.goto(origin+'/#/patients/'+patient.id+'/encounter/'+signed.id+'/visit',{waitUntil:'load'});
  const compact='[data-encounter-step-number="1"] [data-encounter-claim-status] [data-signed-claim-summary]';
  const button=compact+' [data-open-signed-claim-details]';
  const dialog='dialog[data-signed-claim-details][open]';
  await page.waitForSelector(compact,{visible:true});
  assert.ok(directoryReads>0,'Missing charges must still allow a provider lookup');
  assert.equal(await page.$(dialog),null);
  assert.equal(await page.$$eval('[data-encounter-claim-status] .claim-card',nodes=>nodes.filter(node=>node.checkVisibility()).length),0,'Detailed claim cards stay behind Claim details');
  assert.equal(await page.$$eval('[data-encounter-claim-status] [data-open-signed-claim-details]',nodes=>nodes.filter(node=>node.checkVisibility()).length),1);
  await page.locator(button).click();
  await page.waitForSelector(dialog,{visible:true});
  if(ambiguous)await page.waitForSelector(dialog+' [data-check="practice-billing_npi"]',{visible:true});
  else if(!unmatched)assert.equal(await page.$(dialog+' [data-check="practice-billing_npi"]'),null,'A single group may use its eligible rendering clinician NPI');
  if(unmatched)await page.waitForSelector(dialog+' [data-check="practice-rendering_npi"]',{visible:true});
  const info=dialog+' [data-signed-claim-all-fields]';
  assert.equal(await page.$eval(info,details=>details.open),false,'saved fields stay out of the way');
  await page.locator(info+' > summary').click();
  if(unmatched){
   assert.doesNotMatch(await page.$eval(dialog,n=>n.innerText),/1245319599|1234567893/,'The wrong provider cannot supply this encounter NPI');
  }else{
   assert.equal(await page.$(dialog+' [data-check="practice-rendering_npi"]'),null);
   assert.match(await page.$eval(dialog,n=>n.innerText),/1234567893/);
   assert.match(await page.$eval(dialog,n=>n.innerText),/Synthetic treating physician/);
  }
  assert.match(await page.$eval(dialog,n=>n.innerText),/SYN123/);
  await page.$eval(dialog,node=>{node.dataset.browserIdentity='open';});
  await page.evaluate(()=>loadEncounterRevenueStatus(null,true));
  await page.waitForSelector(dialog+'[data-browser-identity="open"]',{visible:true});
  if(ambiguous)assert.ok(await page.$(dialog+' [data-billing-organizations], '+dialog+' [data-details-edit]'),'Billing staff have a way to resolve a missing group identity');
  assert.deepEqual(writes,[]);
  await page.keyboard.press('Escape');
  await page.waitForSelector(dialog,{hidden:true});
  await page.waitForFunction(selector=>document.querySelector(selector)===document.activeElement,{},button);
  assert.equal(await page.$(compact+' [data-encounter-codes-anchor]'),null,'Visit already has the coding action');
  const add='#encounter-documentation [data-open-encounter-codes]';
  assert.equal(await page.$eval(add,n=>n.innerText),'Add diagnosis');
  if(viewport.width===390){
   const anchored='[data-encounter-step-open="1"]';
   await page.locator(anchored).click();
   const rect=await page.$eval(add,el=>{
    const target=el.getBoundingClientRect();
    return {dy:target.y+target.height/2-Math.round(innerHeight*.8),x:innerWidth-20,y:innerHeight-40};
   });
   const reachable=selector=>{
    const el=document.querySelector(selector),r=el.getBoundingClientRect();
    return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;
   };
   if(!await page.evaluate(reachable,add)){
    await page.mouse.move(rect.x,rect.y);
    await page.mouse.wheel({deltaY:rect.dy});
   }
   await page.waitForFunction(reachable,{},add);
  }
  await page.locator(add).click();
  await page.waitForSelector('dialog[data-encounter-codes-dialog][open]',{visible:true});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  console.log('PASS '+viewport.width+'px signed insured visit: '+variant+', compact claim, stable review and first code entry');
 }catch(error){console.error(viewport.width,errors,writes,await page.evaluate(()=>({notice:document.getElementById('notice')?.textContent,claim:document.querySelector('[data-encounter-claim-status]')?.innerText.slice(0,420),dialog:document.querySelector('dialog[open]')?.innerText.slice(0,420)})));throw error;}
 finally{await context.close();}
}
async function checkClaimResponse(browser,viewport,returned=false,held=false){
 const reason='Synthetic response: the procedure modifier does not match the billed service.';
 const ctx=await browser.createBrowserContext(),page=await ctx.newPage(),errors=[],writes=[];
 const currentVisit={...visit,status:'signed',signed_at:appointment.ends_at};
 const billing=fixture(patientPath+'/billing',currentVisit,'insured',null,{});
 const claim={...billing.claims[0],patient_id:patient.id,account_id:billing.accounts[0].id,
  status:held?'submitted':returned?'rejected':'adjudicated',control_number:held?'SYN-HELD':returned?'SYN-RETURN':'SYN-APPEAL',
  answer:returned||held?undefined:{denied:true,paid_cents:0},
  snapshot:{account:billing.accounts[0],patient}};
 billing.claims=[claim];
 const source={report_id:id(860),submission_id:id(861),external_claim_id:'SYN-CLAIMMD-467',
  message:'NCCI - Procedure Code [64405] requires an appropriate modifier when procedure [20553] present.',
  line:{index:0,code:'64405',modifiers:'50',description:'Synthetic affected procedure'},
  related_lines:[{index:1,code:'20553',modifiers:'',description:'Synthetic related procedure'}]};
 const position={needs_correction:true,correction:source};
 const correctionPath='/api/v1/billing/claims/'+claim.id+'/claimmd-correction';
 let draft=null;
 const correction=()=>({claim_version:claim.version,source,draft,portal_url:'https://www.claim.md/'});
 const summary={...billing.summary,claim,state:held?'claimmd_correction':returned?'claim_rejected':'denied',
  insurance:{...billing.summary.insurance,status:held?'submitted':returned?'rejected':'denied',...(held?{claimmd:position}:{})}};
 billing.summary=summary;
 await page.setViewport(viewport);page.setDefaultTimeout(12000);
 const theme=viewport.isMobile?'dark':'light';
 await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme}]);
 page.on('pageerror',e=>errors.push(e.message));
 await page.setRequestInterception(true);
 page.on('request',r=>{const u=new URL(r.url()),path=u.pathname;
  if(u.origin!==origin)return r.abort();
  if(r.method()!=='GET'){
   const body=JSON.parse(r.postData()||'{}');
   writes.push({path,body});
   if(path.endsWith('/denial'))return r.respond({status:200,contentType:'application/json',body:'{}'});
   if(held&&path===correctionPath){
    draft={modifiers:body.modifiers,...(body.reviewed?{reviewed_at:appointment.ends_at}:{})};
    return r.respond({status:200,contentType:'application/json',body:JSON.stringify(correction())});
   }
   return r.abort();
  }
  let value;
  if(path===patientPath+'/billing')value=billing;
  else if(path===patientPath+'/billing/visit-summary')value=summary;
  else if(path==='/api/v1/billing/provider-settings')value={items:[{id:id(901),verified:true,enabled:true}]};
  else if(held&&path===correctionPath)value=correction();
  else if(path==='/api/v1/billing/claims/'+claim.id)value={claim,...(held?{claimmd_position:position}:{}),tracking:returned?{
   submissions:[{status:'delivered'}],
   reports:[{received_at:appointment.ends_at,evidence:{senderid:'SYNPAYER',sender_name:'Synthetic PPO',
    status:'R',message:{status:'R',message:reason}}}]
  }:{}};
  else if(path==='/api/v1/billing/claims/'+claim.id+'/history')value={items:[]};
  else if(path==='/api/v1/billing/claimmd/status')value={configured:true,connected:true,active:{id:id(901),usage:'T'}};
  else if(path.startsWith('/api/')||path.startsWith('/auth/'))value=fixture(path,currentVisit,'insured',null,{});
  else if(/^\/$|\.(css|js|png|svg|webp|woff2?|ico)$/.test(path))return r.continue();
  else return r.abort();
  return r.respond({status:200,contentType:'application/json',body:JSON.stringify(value)});
 });
 try{
  await page.goto(origin+'/#/patients/'+patient.id+'/encounter/'+visit.id+'/visit');
  const summarySelector='[data-encounter-step-number="1"] [data-signed-claim-summary]';
  const trigger=summarySelector+' [data-open-signed-claim-details]',details='dialog[data-signed-claim-details][open]',editor='dialog[data-visit-denial-editor][open]';
  await page.waitForSelector(trigger,{visible:true});
  if(held){
   assert.match(await page.$eval(summarySelector,n=>n.innerText),/Fix 64405/);
   await page.locator(trigger).click();
   const field=details+' [data-held-modifiers]';
   await page.waitForSelector(field,{visible:true});
   assert.equal(await page.$eval(field,input=>input.value),'50');
   assert.equal(await page.$(details+' [data-denial-action]'),null);
   assert.match(await page.$eval(details,node=>node.innerText),/64405.*20553/s);
   assert.equal(await page.$eval(field,input=>input.readOnly),false);
   assert.match(await page.$eval(details+' #held-modifier-help',node=>node.innerText),/signed note documents separate structures/);
   const xs=details+' [data-modifier-toggle="XS"]';
   assert.equal(await page.$eval(xs,button=>button.getAttribute('aria-pressed')),'false');
   assert.deepEqual(writes,[],'showing modifier options never changes the claim');
   const screenshotDir=process.env.CLAIM_DETAILS_SCREENSHOT_DIR;
   if(screenshotDir){
    await page.waitForFunction(selector=>getComputedStyle(document.querySelector(selector)).opacity==='1',{},details);
    await (await page.$(details)).screenshot({path:path.join(screenshotDir,`held-claim-modifiers-${viewport.width}.png`)});
   }
   await page.locator(xs).click();
   await page.waitForFunction(()=>document.querySelector('[data-held-save-status]')?.textContent==='Saved');
   assert.equal(await page.$eval(xs,button=>button.getAttribute('aria-pressed')),'true');
   assert.equal(await page.$eval(field,input=>input.value),'50 XS');
   assert.deepEqual(writes,[{path:correctionPath,body:{report_id:source.report_id,submission_id:source.submission_id,line_index:0,modifiers:['50','XS']}}]);
   await page.locator(details+' [data-held-review]').click();
   assert.match(await page.$eval(details,node=>node.innerText),/SYN-CLAIMMD-467.*50, XS/s);
   await page.locator(details+' [data-held-confirm]').click();
   const link=details+' a[href="https://www.claim.md/"]';
   await page.waitForSelector(link,{visible:true});
   assert.deepEqual(writes,[writes[0],{path:correctionPath,body:{...writes[0].body,reviewed:true}}]);
   assert.match(await page.$eval(link,node=>node.textContent),/Continue in Claim.MD/);
   assert.equal(await page.$(details+' [data-signed-claim-send]'),null);
   assert.deepEqual(errors,[]);
   console.log(viewport.width+'px PASS held claim: verified line focus, autosave, single confirmation and scoped Claim.MD portal handoff');
   return;
  }
  assert.match(await page.$eval(summarySelector,n=>n.innerText),returned?/Returned before payer acceptance.*Review returned claim/s:/Review payer decision/);
  assert.ok(!(await page.$(summarySelector+' [data-denial-action]')));
  if(returned){
   await page.locator(trigger).click();
   const overview=details+' [data-signed-claim-overview]',stage=overview+' .signed-claim-stage';
   await page.waitForSelector(stage+' .signed-claim-reason',{visible:true});
   await page.waitForFunction(sel=>getComputedStyle(document.querySelector(sel)).opacity==='1',{},details);
   const status=await page.$eval(overview,n=>n.innerText);
   assert.match(status,/Avery Example.*SYN-RETURN/s);
   assert.match(status,/Returned before payer acceptance/);
   assert.match(status,/Received by the clearinghouse/);
   assert.match(status,/No payer acceptance on file/);
   assert.doesNotMatch(status,/Denied by|Rejected by the payer/);
   assert.ok(status.includes(reason));
   assert.equal(await page.$(details+' [data-denial-action], '+details+' [data-denial-appeal]'),null);
   assert.equal(await page.$eval('[data-encounter-step-open="2"]',node=>node.textContent.trim()),'Payment');
   assert.equal(await page.$eval('[data-insurer-payment-summary]',node=>node.textContent),'Insurer payment pending claim correction');
   const activity=details+' [data-signed-claim-activity]';
   assert.equal(await page.$eval(activity,n=>n.open),false);
   assert.equal(await page.$eval(details+' [data-signed-claim-other]',n=>n.open),false);
   const primary=stage+' [data-signed-claim-review="response"]';
   assert.equal(await page.$$eval(stage+' button',nodes=>nodes.length),1);
   const geometry=await page.$eval(details,n=>{
    const {x,y,right,bottom}=n.getBoundingClientRect(),button=n.querySelector('[data-signed-claim-review]').getBoundingClientRect();
    return {fits:x>=0&&y>=0&&right<=innerWidth&&bottom<=innerHeight&&n.scrollWidth<=n.clientWidth,
     actionVisible:button.bottom<=bottom,theme:document.documentElement.dataset.theme};
   });
   assert.deepEqual(geometry,{fits:true,actionVisible:true,theme});
   const screenshotDir=process.env.CLAIM_DETAILS_SCREENSHOT_DIR;
   if(screenshotDir)await (await page.$(details)).screenshot({path:path.join(screenshotDir,`claim-details-${viewport.width}-${theme}.png`)});
   const initialScroll=await page.$eval(details,n=>n.scrollTop);
   if(viewport.isMobile)await page.locator(activity+' > summary').click();
   else await page.locator(primary).click();
   await page.waitForSelector(activity+'[open] [data-claim-problem-box]',{visible:true});
   if(viewport.isMobile)assert.equal(await page.$eval(details,n=>n.scrollTop),initialScroll,'opening history directly preserves scroll');
   assert.match(await page.$eval(activity+' [data-claim-problem-box]',n=>n.innerText),/Fix and resend/);
   assert.equal(await page.$eval(activity+' .claim-progress-more',n=>n.open),false);
   const progress=activity+' .claim-progress-bar';
   assert.equal(await page.$eval(progress,n=>n.checkVisibility()),false);
   await page.keyboard.press('Escape');
   await page.waitForSelector(details,{hidden:true});
   await page.waitForFunction(selector=>document.querySelector(selector)===document.activeElement,{},trigger);
   assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
   console.log(viewport.width+'px '+theme+' PASS claim returned before payer acceptance: reason first, scoped activity, no horizontal overflow, restored focus, zero writes');
   return;
  }
  for(const [button,field] of [['[data-denial-appeal]','[name=native_claim_id]'],['[data-denial-action=write_off]','button[type=submit]'],['[data-denial-action=patient_balance]','button[type=submit]']]){
   if(!(await page.$(details)))await page.locator(trigger).click();
   const actions=details+' [data-signed-claim-other]';
   if(!await page.$eval(actions,n=>n.open))await page.locator(actions+' > summary').click();
   await page.waitForSelector(actions+' '+button,{visible:true});
   await page.locator(actions+' '+button).click();
   await page.waitForSelector(editor+' '+field,{visible:true});
   assert.equal(await page.$('dialog[data-encounter-codes-dialog][open]'),null);
   if(field.includes('native'))assert.equal(await page.$eval(editor+' '+field,n=>n.value),claim.id);
   if(button.includes('patient_balance')){
    // The practice can make the reason optional. Submit both configurations through the real form.
    if(await page.$eval(editor+' [name=reason]',n=>n.checkVisibility()))await page.type(editor+' [name=reason]','Synthetic reviewed denial');
    await page.locator(editor+' button[type=submit]').click();
    await page.waitForSelector(editor,{hidden:true});
    await page.waitForSelector(details,{hidden:true});
   }else{await page.keyboard.press('Escape');await page.waitForSelector(editor,{hidden:true});}
  }
  assert.equal(writes.length,1);
  assert.equal(writes[0].path,patientPath+'/billing/accounts/'+billing.accounts[0].id+'/denial');
  assert.equal(writes[0].body.action,'patient_balance');
  assert.equal(writes[0].body.claim_id,claim.id);
  assert.ok(writes[0].body.reason.trim());
  assert.deepEqual(errors,[]);
  console.log(viewport.width+'px PASS denied claim: visible primary, scoped appeal, cancelled write-off, confirmed move to synthetic patient balance');
 }catch(error){
  console.error(viewport.width,returned?'returned':'denied',errors,writes,await page.evaluate(()=>({
   notice:document.getElementById('notice')?.textContent,dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>n.innerText.slice(0,900)),
   otherOpen:document.querySelector('[data-signed-claim-other]')?.open,
  })));
  throw error;
 }finally{await ctx.close();}
}
async function checkReadyClaim(browser,viewport,delegated=false,canceled=false,canceledSource='encounter',blocked=''){
 const context=await browser.createBrowserContext(),page=await context.newPage(),errors=[],writes=[];
 const signed={...visit,status:'signed',signed_at:appointment.ends_at};
 const billing=fixture(patientPath+'/billing',signed,'insured',null,{});
 const theme=viewport.isMobile?'light':'dark',authorization=viewport.isMobile?'SYN-BOX23':'';
 const account=billing.accounts[0],coverage=billing.coverages[0],payer={id:coverage.content.payer_id,content:{name:'Synthetic Medicare',payer_code:'SYN-MEDICARE'}};
 account.coverage_snapshot={coverage:{...coverage,content:{...coverage.content,relationship:'self'}},payer};
 account.content.claim_details={prior_authorization_number:'SYN-ACCOUNT-AUTH'};
 const content={billing_provider_name:'Synthetic Practice',billing_address:'100 Synthetic Avenue',tax_id:'123456789',
  patient_address:'100 Synthetic Avenue, Trenton, NJ 08608',
  billing_npi:'1234567893',rendering_npi:'1234567893',place_of_service:'11',subscriber_address:'100 Synthetic Avenue, Trenton, NJ 08608',
  subscriber_birth_date:patient.birth_date,diagnosis_codes:account.content.lines[0].diagnosis_codes,line_diagnosis_pointers:[[1]],
  encounter:authorization?{prior_authorization_number:authorization}:{}};
 const claim={...billing.claims[0],patient_id:patient.id,account_id:account.id,control_number:'SYN-READY',payer_name:payer.content.name,
  status:viewport.isMobile?'draft':'ready',version:1,content,snapshot:{account,patient}};
 if(blocked==='field'){
  claim.content.place_of_service='';
  claim.status='ready';
  claim.can_return_to_draft=true;
 }
 billing.claims=[claim];
 const summary={...billing.summary,claim,viewer:{delegated},insurance:{...billing.summary.insurance,insurer:payer.content.name}};
 billing.summary=summary;
 const claimEndpoint='/api/v1/billing/claims/'+claim.id;
 const prepareEndpoint=patientPath+'/billing/accounts/'+account.id+'/claims/prepare';
 if(canceled){
  account.version=2;
  summary.account={...summary.account,version:account.version};
 }
 const original={...claim,id:id(833),status:'void',version:4,control_number:'SYN-CANCELLED',
  snapshot:{...claim.snapshot,account:{...account,version:1}}};
 const older={...original,id:id(834),control_number:'SYN-OLDER-CANCELLATION'};
 const correction={claim_id:original.id,account_id:account.id,encounter_id:signed.id,version:original.version,account_version:account.version};
 const worklistOriginal={...original,visit_id:signed.id,patient_name:'Example, Avery',service_date:account.service_date,
  total_cents:account.total_cents,canceled_claim_recovery:correction};
 const beforeResubmit={...summary,state:'claim_cancelled',claim:null,canceled_claim:{id:original.id,version:original.version}};
 if(canceled)billing.claims=[original];
 const handoffEndpoint=patientPath+'/billing/visits/'+signed.id+'/claim-handoff';
 const partner={id:id(829),partner_id:id(830),partner_version:1,route_key:'synthetic-claimmd',usage:'T'};
 const artifact={id:id(831),version:1,claim_id:claim.id,partner_id:partner.partner_id,partner_version:partner.partner_version};
 const deliveryEndpoint='/api/v1/billing/submissions/'+artifact.id+'/delivery';
 let previewReads=0,failNextAuthorization=false,submissionIssues=[],releaseFirstAuthorization;
 const submissionDefaults={
  patient_address:{line1:'100 Synthetic Avenue',city:'Trenton',state:'NJ',postal_code:'08608'},
  billing_address:{line1:'400 Synthetic Clinic',city:'Trenton',state:'NJ',postal_code:'08608'},
  subscriber_address:{line1:'100 Synthetic Avenue',city:'Trenton',state:'NJ',postal_code:'08608'},
  subscriber_given_name:patient.given_name,subscriber_family_name:patient.family_name,rendering_given_name:'Synthetic',rendering_family_name:'Clinician',
  billing_taxonomy:'207Q00000X',filing_indicator:'MB'
 };
 try{
  await page.setViewport(viewport);page.setDefaultTimeout(12000);
  await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme}]);
  await page.setRequestInterception(true);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>void (async()=>{
   const url=new URL(request.url()),route=url.pathname;
   if(url.origin!==origin)return request.abort();
   if(canceled&&route==='/api/v1/billing/claimmd/'+partner.id+'/uploaded-files/sync'&&request.method()==='POST')
    return request.respond({status:200,contentType:'application/json',body:'{}'});
   if(request.method()!=='GET'){
    const body=JSON.parse(request.postData()||'{}'),version=request.headers()['if-match'];
    writes.push({method:request.method(),route,body,version});
    if(canceled&&route===prepareEndpoint){
     assert.equal(request.method(),'POST');
     assert.deepEqual(body,{again:true,canceled_claim_id:original.id,canceled_claim_version:original.version,canceled_account_version:account.version});
     billing.claims=[original,claim];
     return request.respond({status:200,contentType:'application/json',body:JSON.stringify({outcome:'prepared',claim_id:claim.id})});
    }
    if(route===claimEndpoint&&request.method()==='PUT'){
     if(body.content.encounter.prior_authorization_number==='SYN-FIRST-EDIT')await new Promise(resolve=>{releaseFirstAuthorization=resolve;});
     if(failNextAuthorization){failNextAuthorization=false;return request.respond({status:409,contentType:'application/json',body:JSON.stringify({message:'Check the current prior authorization before saving.'})});}
     assert.equal(version,JSON.stringify(String(claim.version)));
     claim.version++;claim.content=body.content;
     return request.respond({status:200,contentType:'application/json',body:JSON.stringify(claim)});
    }
    if(route===handoffEndpoint)return request.respond({status:200,contentType:'application/json',body:JSON.stringify({
     outcome:'needs_review',visit_id:signed.id,account_id:account.id,signed:true,visit_version:signed.version
    })});
    if(blocked==='field'&&route===claimEndpoint+'/actions'&&body.action==='return_to_draft'){
     assert.equal(version,JSON.stringify(String(claim.version)));
     claim.status='draft';claim.version++;claim.can_return_to_draft=false;
     return request.respond({status:200,contentType:'application/json',body:JSON.stringify(claim)});
    }
    if(delegated&&route===claimEndpoint+'/actions'&&body.action==='ready'){
     assert.equal(version,JSON.stringify(String(claim.version)));
     claim.status='ready';claim.version++;
     return request.respond({status:200,contentType:'application/json',body:JSON.stringify(claim)});
    }
    if(delegated&&route===claimEndpoint+'/837p'){
     assert.equal(version,JSON.stringify(String(claim.version)));
     return request.respond({status:200,contentType:'application/json',body:JSON.stringify({...artifact,claim_version:claim.version})});
    }
    if(delegated&&route===deliveryEndpoint)return request.respond({status:200,contentType:'application/json',body:JSON.stringify({
     id:id(832),submission_id:artifact.id,route_key:partner.route_key,status:'queued'
    })});
    return request.abort();
   }
   if(route===claimEndpoint+'/cms1500'){
    previewReads++;
    return request.respond({status:200,contentType:'text/html',body:`<!DOCTYPE html><title>Synthetic CMS-1500</title><p>Box 23: ${claim.content.encounter.prior_authorization_number||'empty'}</p>`});
   }
   let data;
   if(route===patientPath+'/billing')data=billing;
   else if(route===patientPath+'/billing/visit-summary')data=canceled&&billing.claims.length===1?beforeResubmit:summary;
   else if(canceled&&route==='/api/v1/billing/claims')data={items:[older,worklistOriginal],total:2};
   else if(canceled&&route==='/api/v1/billing/claims/'+original.id)data={claim:original,canceled_claim_recovery:correction,preflight_issues:[],tracking:{}};
   else if(canceled&&route==='/api/v1/billing/era-automation')data={feeds:[],items:[],events:[]};
   else if(canceled&&route==='/api/v1/billing/claimmd/'+partner.id+'/operations')data={records:[]};
   else if(route===patientPath+'/demographics')data={patient_id:patient.id,content:{address:{line1:'100 Synthetic Avenue',city:'Trenton',region:'NJ',postal_code:'08608'}}};
   else if(route==='/api/v1/billing/payers')data={items:[payer],total:1};
   else if(delegated&&route==='/auth/me')data={...staff,delegated:true,delegated_role:'partner_admin'};
   else if((delegated||blocked)&&route==='/api/v1/billing/claimmd/status')data={configured:blocked!=='connection',connected:blocked!=='connection',active:blocked==='connection'?null:partner};
   else if(route===claimEndpoint)data={claim,can_return_to_draft:claim.can_return_to_draft,preflight_issues:claim.content.place_of_service?[]:['Two-digit place of service is required'],submission_issues:submissionIssues,submission_defaults:submissionDefaults,tracking:{}};
   else if(route.startsWith('/api/')||route.startsWith('/auth/'))data=fixture(route,signed,'insured',null,{});
   else if(/^\/$|\.(css|js|png|svg|webp|woff2?|ico)$/.test(route))return request.continue();
   else return request.abort();
   return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
  })().catch(async error=>{errors.push(error.message);if(!request.isInterceptResolutionHandled())await request.abort().catch(()=>{});}));
  const section=delegated&&viewport.isMobile?'charges':'visit';
  const start=canceledSource==='worklist'?'/claims':canceledSource==='history'?'/claims/'+original.id:
   '/patients/'+patient.id+'/encounter/'+signed.id+'/'+section;
  await page.goto(origin+'/#'+start);
  const trigger='[data-encounter-step-number="1"] [data-signed-claim-summary] [data-open-signed-claim-details]';
  const dialog='dialog[data-signed-claim-details][open]',overview=dialog+' [data-signed-claim-overview]';
  const send=overview+' [data-signed-claim-send]',preview=overview+' [data-encounter-claim-form]';
  if(canceled){
   let action;
   if(canceledSource==='encounter'){
    const next='[data-encounter-next]';
    await page.waitForFunction(selector=>document.querySelector(selector)?.textContent==='Resubmit claim',{},next);
    await page.waitForSelector('[data-visit-claim-resend][data-encounter-next-source]',{visible:true});
    // A charge deep link can start below the toolbar on mobile.
    action=viewport.isMobile&&delegated?'[data-visit-claim-resend]':next;
   }else{
    const pane=canceledSource==='worklist'?'[data-claim-worklist]':'#claims-detail';
    action=pane+' [data-claim-open="'+original.id+'"][data-claim-intent="resubmit"]';
    await page.waitForSelector(action,{visible:true});
    assert.equal(await page.$eval(action,button=>button.textContent),'Resubmit claim');
    assert.equal(await page.$(pane+' [data-claim-open="'+older.id+'"]'),null);
    if(canceledSource==='history'){
     assert.match(await page.$eval(pane,node=>node.innerText),/Canceled before sending/);
     assert.doesNotMatch(await page.$eval(pane,node=>node.innerText),/Now: Finish the claim/);
    }
   }
   assert.deepEqual(writes,[],'loading a canceled claim does not prepare or send');
   await page.locator(action).click();
   await page.waitForSelector(dialog+'[data-signed-claim-details="'+claim.id+'"]',{visible:true});
   assert.deepEqual(writes.map(write=>write.route),[prepareEndpoint],'resubmit creates only the exact replacement draft');
   const review=overview+(delegated?' [data-signed-claim-native-review]':' [data-signed-claim-send]');
   await page.waitForSelector(review,{visible:true});
   if(delegated){
    const form=dialog+' #claimmd-submit-form';
    await page.locator(review).click();
    await page.waitForSelector(form,{visible:true});
    assert.deepEqual(await page.$$eval(form+' input[required][type=checkbox]',boxes=>boxes.map(box=>box.checked)),[false,false,false,false]);
   }else{
    assert.match(await page.$eval(dialog+' #signed-claim-attestation',node=>node.innerText),/By selecting Send claim to Claim.MD, I confirm the provider signature is on file/);
    await page.$eval(review,button=>button.click());
   }
   await page.keyboard.press('Escape');
   await page.waitForSelector(dialog,{hidden:true});
   assert.deepEqual(writes.map(write=>write.route),delegated&&viewport.isMobile?[prepareEndpoint,claimEndpoint+'/actions']:[prepareEndpoint]);
   assert.deepEqual(errors,[]);
   console.log(viewport.width+'px PASS canceled claim from '+canceledSource+' creates an exact new draft, with separate '+(delegated?'delegated':'direct')+' consent and no delivery on close');
   return;
  }
  await page.locator(trigger).click();
  if(blocked){
   const edit=overview+' [data-signed-claim-edit-ready]';
   const place=dialog+' [data-signed-claim-fix="place_of_service"]';
   if(blocked==='connection'){
    await page.waitForSelector(dialog+' [data-check="claimmd-connection"]',{visible:true});
    assert.equal(await page.$(send),null);
    assert.equal(await page.$(edit),null);
    assert.deepEqual(writes,[]);
   }else{
    await page.waitForSelector(edit,{visible:true});
    assert.equal(await page.$(send),null);
    assert.equal(await page.$(place),null);
    assert.deepEqual(writes,[]);
    await page.locator(edit).click();
    await page.waitForSelector(place,{visible:true});
    assert.equal(await page.$eval(place+' input',input=>input===document.activeElement),true);
    await page.locator(place+' input').fill('11');
    await page.waitForSelector(send,{visible:true});
    assert.deepEqual(writes.map(({route,method})=>[method,route]),[['POST',claimEndpoint+'/actions'],['PUT',claimEndpoint]]);
    assert.equal(writes[1].body.content.place_of_service,'11');
   }
   await page.keyboard.press('Escape');
   await page.waitForSelector(dialog,{hidden:true});
   assert.deepEqual(errors,[]);
   console.log(viewport.width+'px PASS '+(blocked==='field'?'reopens the exact ready claim, focuses and autosaves the missing field':'no send shown without a Claim.MD connection'));
   return;
  }
  if(delegated){
   const review=overview+' [data-signed-claim-native-review]',form=dialog+' #claimmd-submit-form';
   const permissions=['signature_on_file','benefits_assigned','release_authorized','routine_professional_reviewed'];
   await page.waitForSelector(review,{visible:true});
   assert.equal(await page.$(send),null,'the delegated actor cannot enter the encounter handoff');
   assert.deepEqual(writes,[],'opening claim review does not write');
   if(!viewport.isMobile){
    claim.version++;
    await page.locator(review).click();
    await page.waitForSelector(overview+' [data-signed-claim-review-error]',{visible:true});
    assert.match(await page.$eval(overview,node=>node.innerText),/The claim changed/);
    assert.equal(await page.$(form),null);
    assert.deepEqual(writes,[]);
    await page.keyboard.press('Escape');await page.waitForSelector(dialog,{hidden:true});
    await page.locator(trigger).click();
   }
   await page.locator(review).click();
   await page.waitForSelector(form,{visible:true});
   assert.equal(await page.$$eval('dialog[open]',nodes=>nodes.length),1,'the existing consent form stays in the same review sheet');
   assert.doesNotMatch(await page.$eval(form,node=>node.innerText),/Save claim file without sending/);
   assert.deepEqual(await page.$eval(form,(node,fields)=>fields.map(name=>[node.elements[name].required,node.elements[name].checked]),permissions),permissions.map(()=>[true,false]));
   assert.deepEqual(writes.map(item=>item.route),viewport.isMobile?[claimEndpoint+'/actions']:[],'opening consent only releases an explicitly selected draft to ready');
   if(viewport.isMobile){
    await page.locator(dialog+' [data-signed-claim-native-back]').click();
    await page.waitForSelector(review,{visible:true});
    assert.equal(await page.$(form),null);
    await page.locator(review).click();
    await page.waitForSelector(form,{visible:true});
    assert.equal(writes.length,1,'returning to review does not release the draft a second time');
    await page.keyboard.press('Escape');await page.waitForSelector(dialog,{hidden:true});
    assert.equal(writes.length,1,'closing without consent creates no transmission');
   }else{
    const queue=form+' [name="claimmd_action"][value="queue"]';
    await page.locator(queue).click();
    assert.deepEqual(writes,[],'unchecked attestations block the final action');
    for(const name of permissions)await page.locator(form+' [name="'+name+'"]').click();
    await page.locator(queue).click();
    await page.waitForFunction(()=>document.querySelector('.signed-claim-dialog .signed-claim-stage')?.innerText.includes('Queued for Claim.MD'));
    assert.equal(await page.$(queue),null);
    assert.deepEqual(writes.map(item=>item.route),[claimEndpoint+'/837p',deliveryEndpoint]);
    assert.match(writes[0].body.reason,/Reviewed claim for electronic submission/);
    for(const name of permissions)assert.equal(writes[0].body.details[name],true);
   }
   assert.deepEqual(errors,[]);
   console.log(viewport.width+'px PASS delegated native consent: same sheet, no automatic handoff, '+(viewport.isMobile?'draft review cancels without delivery':'stale version rejected and explicit recorded consent'));
   return;
  }
  await page.waitForSelector(send,{visible:true});
  await page.waitForFunction(selector=>getComputedStyle(document.querySelector(selector)).opacity==='1',{},dialog);
  assert.match(await page.$eval(overview,node=>node.innerText),/Avery Example.*SYN-READY.*Synthetic Medicare.*Prior authorization\s+\(Box 23\).*Ready to send.*This claim has not been sent\./s);
  assert.equal(await page.$eval(overview+' [data-signed-claim-authorization]',node=>node.querySelector('input')?.value??node.textContent),authorization||'Not entered');
  assert.doesNotMatch(await page.$eval(dialog,node=>node.innerText),/Review and send|Claim progress|Now: Finish the claim|SYN-ACCOUNT-AUTH/);
  assert.match(await page.$eval(overview+' #signed-claim-attestation',node=>node.innerText),/confirm the provider signature is on file, benefits are assigned, release of information is authorized, and I reviewed the codes and addresses/);
  assert.match(await page.$eval(overview,node=>node.innerText),/Diagnoses.*Procedures.*Patient address.*400 Synthetic Clinic/s);
  assert.deepEqual(await page.$$eval(dialog+' button.primary',nodes=>nodes.filter(node=>node.checkVisibility()).map(node=>node.textContent.trim())),['Send claim to Claim.MD']);
  assert.equal(await page.$$eval(dialog+' details[open]',nodes=>nodes.filter(node=>node.checkVisibility()).length),0);
  assert.equal(await page.$eval(preview,node=>node.textContent),'Preview claim form');
  const geometry=await page.$eval(dialog,node=>{
   const {x,y,right,bottom}=node.getBoundingClientRect();
   return {fits:x>=0&&y>=0&&right<=innerWidth&&bottom<=innerHeight&&node.scrollWidth<=node.clientWidth,
    actionVisible:node.querySelector('[data-signed-claim-send]').getBoundingClientRect().bottom<=bottom,theme:document.documentElement.dataset.theme};
  });
  assert.deepEqual(geometry,{fits:true,actionVisible:true,theme});
  const screenshotDir=process.env.CLAIM_DETAILS_SCREENSHOT_DIR;
  if(screenshotDir)await (await page.$(dialog)).screenshot({path:path.join(screenshotDir,`ready-claim-details-${viewport.width}-${theme}.png`)});
  // A script click cannot attest. Physical browser preview leaves the same review sheet open.
  await page.$eval(send,node=>node.click());
  assert.deepEqual(writes,[]);
  await page.locator(preview).click();
  const previewSheet='dialog.receipt-preview-sheet[open]';
  await page.waitForSelector(previewSheet+' iframe[title="Claim form (CMS-1500)"]',{visible:true});
  assert.equal(previewReads,1);
  await page.keyboard.press('Escape');
  await page.waitForSelector(previewSheet,{hidden:true});
  await page.waitForSelector(dialog,{visible:true});
  await page.keyboard.press('Escape');
  await page.waitForSelector(dialog,{hidden:true});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  if(viewport.isMobile){
   // Both claim reads are scoped to the reviewed claim. A printable address does not suppress the
   // electronic validation of its actual saved fields, and a failed check opens no send prompt.
   submissionIssues=[{field:'patient_address',message:'Patient address needs valid US state and ZIP for electronic submission.'}];
   await page.locator(trigger).click();
   const address=dialog+' [data-check="patient-address"]';
   await page.waitForSelector(address,{visible:true});
   assert.match(await page.$eval(address,node=>node.innerText),/US state and ZIP.*Edit patient address/s);
   assert.equal(await page.$(send),null);
   assert.equal(await page.$$eval(address,nodes=>nodes.length),1);
   await page.keyboard.press('Escape');await page.waitForSelector(dialog,{hidden:true});
   submissionIssues=[];
   await page.locator(trigger).click();await page.waitForSelector(send,{visible:true});

   // Preview immediately after an edit must flush both the in-flight version and the latest value.
   const auth=dialog+' input[data-signed-claim-auth]';
   await page.locator(auth).fill('SYN-FIRST-EDIT');
   await page.waitForFunction(()=>document.querySelector('[data-signed-claim-auth-status]')?.textContent==='Saving…');
   for(let attempt=0;attempt<200&&!releaseFirstAuthorization;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
   assert.equal(typeof releaseFirstAuthorization,'function','the first versioned autosave reached the fixture');
   await page.locator(auth).fill('SYN-LATEST-EDIT');
   const openPreview=page.locator(preview).click();
   releaseFirstAuthorization();
   await openPreview;
   const frameNode=await page.waitForSelector(previewSheet+' iframe[title="Claim form (CMS-1500)"]',{visible:true});
   const frame=await frameNode.contentFrame();
   await frame.waitForFunction(()=>document.body.innerText.includes('Box 23: SYN-LATEST-EDIT'));
   assert.equal(previewReads,2);
   assert.deepEqual(writes.map(item=>[item.method,item.route,item.version,item.body.content.encounter.prior_authorization_number]),[
    ['PUT',claimEndpoint,'"1"','SYN-FIRST-EDIT'],['PUT',claimEndpoint,'"2"','SYN-LATEST-EDIT']
   ]);
   await page.keyboard.press('Escape');await page.waitForSelector(previewSheet,{hidden:true});
   await page.waitForSelector(dialog,{visible:true});

   // A Box 23 conflict preserves the value and prevents the explicit send from writing anything.
   failNextAuthorization=true;
   await page.locator(auth).fill('SYN-AUTH-RETRY');
   await page.locator(send).click();
   await page.waitForSelector(dialog+' [data-signed-claim-auth-retry]',{visible:true});
   assert.equal(await page.$eval(auth,node=>node.value),'SYN-AUTH-RETRY');
   assert.equal(await page.$('[role="alertdialog"]'),null);
   await page.locator(dialog+' [data-signed-claim-auth-retry]').click();
   await page.waitForFunction(()=>document.querySelector('[data-signed-claim-auth-status]')?.textContent==='Saved');
   await page.keyboard.press('Escape');await page.waitForSelector(dialog,{hidden:true});
   assert.equal(writes.length,4);
   assert.ok(writes.every(item=>item.method==='PUT'&&item.route===claimEndpoint));

   // Fill a genuinely missing draft claim field directly in the review sheet.
   claim.content.place_of_service='';claim.version++;
   await page.locator(trigger).click();
   const place=dialog+' [data-signed-claim-fix="place_of_service"]';
   await page.waitForSelector(place,{visible:true});
   assert.equal(await page.$(send),null);
   assert.equal(await page.$eval(place+' input',input=>document.activeElement===input),true);
   await page.locator(place+' input').fill('11');
   await page.waitForSelector(send,{visible:true});
   assert.equal(await page.$(place),null);
   assert.equal(writes.length,5);
   assert.equal(writes[4].route,claimEndpoint);
   assert.equal(writes[4].body.content.place_of_service,'11');
   await page.keyboard.press('Escape');await page.waitForSelector(dialog,{hidden:true});
  }
  if(!viewport.isMobile){
   await page.locator(trigger).click();
   // Demographics can change separately from the claim's version. Show the new
   // address and require deliberate review of that saved information.
   await page.waitForSelector(send,{visible:true});
   submissionDefaults.patient_address.city='Synthetic Gardens';
   await page.locator(send).click();
   await page.waitForSelector(overview+' [data-signed-claim-review-error]',{visible:true});
   assert.match(await page.$eval(overview,node=>node.innerText),/Synthetic Gardens.*The claim changed/s);
   assert.deepEqual(writes,[]);
   await page.locator(send).click();
   await page.waitForFunction(()=>document.getElementById('notice')?.innerText.includes('Claim needs review'));
   assert.equal(await page.$('[role="alertdialog"]'),null);
   assert.equal(writes.length,1);
   assert.equal(writes[0].route,handoffEndpoint);
   assert.deepEqual(writes[0].body.reviewed_claim,{id:claim.id,version:claim.version});
   assert.deepEqual(writes[0].body.confirmations,{signature_on_file:true,benefits_assigned:true,release_authorized:true,routine_professional_reviewed:true,synthetic_test_reviewed:false});
  }
  console.log(viewport.width+'px '+theme+' PASS one-sheet claim review, same-sheet attestation, nested preview'+(viewport.isMobile?', autosave, conflict recovery and focused inline fix':', changed-address guard and explicit handoff'));
 }catch(error){
  console.error(viewport.width,canceled?canceledSource:'ready',errors,writes,await page.evaluate(()=>({
   route:location.hash,heading:document.getElementById('page-title')?.textContent,
   worklist:document.getElementById('claims-tool')?.textContent.trim().slice(0,650),
   hidden:document.getElementById('claims-tool')?.closest('[hidden]')?.id,
   notice:document.getElementById('notice')?.textContent,dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.innerText.slice(0,900)),
   claimState:typeof encounterRevenueState==='undefined'?null:encounterRevenueState.data?.summary?.state,
   claimSource:[...document.querySelectorAll('[data-visit-claim-resend]')].map(button=>[button.dataset.visitClaimResend,button.dataset.canceledClaimVersion])
  })));
  throw error;
 }finally{await context.close();}
}
(async()=>{
 const target=process.env.CHART_TEST_BROWSER?{executablePath:process.env.CHART_TEST_BROWSER}:{channel:'chrome'};
 const browser=await puppeteer.launch({...target,headless:true,pipe:true,args:['--disable-background-networking','--disable-component-update','--no-first-run']});
 try{
  for(const viewport of [{width:1280,height:900},{width:390,height:844,isMobile:true,hasTouch:true}]){
   if(process.env.BLOCKED_CLAIM_ONLY==='1'){
    await checkReadyClaim(browser,viewport,false,false,'encounter','field');
    await checkReadyClaim(browser,viewport,false,false,'encounter','connection');
    continue;
   }
   if(process.env.CANCELED_CLAIM_ONLY==='1'){
    await checkReadyClaim(browser,viewport,true,true,'worklist');
    await checkReadyClaim(browser,viewport,false,true,'history');
    continue;
   }
   await checkClaimResponse(browser,viewport,false,true);
   if(process.env.HELD_CLAIM_ONLY==='1')continue;
   for(const variant of ['linked-clinician','several-groups','unmatched-clinician'])await check(browser,viewport,variant);
   await checkClaimResponse(browser,viewport);
   await checkClaimResponse(browser,viewport,true);
   await checkReadyClaim(browser,viewport);
   await checkReadyClaim(browser,viewport,false,false,'encounter','field');
   await checkReadyClaim(browser,viewport,false,false,'encounter','connection');
   await checkReadyClaim(browser,viewport,true);
   await checkReadyClaim(browser,viewport,false,true);
   await checkReadyClaim(browser,viewport,true,true);
   await checkReadyClaim(browser,viewport,true,true,'worklist');
   await checkReadyClaim(browser,viewport,false,true,'history');
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
