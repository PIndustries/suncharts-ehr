// SPDX-License-Identifier: AGPL-3.0-only
// Signed, insured visit before the first charge. API responses are entirely synthetic.
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
  if(unmatched){
   await page.waitForSelector(dialog+' [data-check="practice-rendering_npi"]',{visible:true});
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
  assert.match(await page.$eval(add,n=>n.innerText),/Add codes/);
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
  console.log('PASS '+viewport.width+'px signed insured visit: '+variant+', compact claim, stable review and Add codes');
 }catch(error){console.error(viewport.width,errors,writes,await page.evaluate(()=>({notice:document.getElementById('notice')?.textContent,claim:document.querySelector('[data-encounter-claim-status]')?.innerText.slice(0,420),dialog:document.querySelector('dialog[open]')?.innerText.slice(0,420)})));throw error;}
 finally{await context.close();}
}
async function checkClaimResponse(browser,viewport,returned=false){
 const reason='Synthetic response: the procedure modifier does not match the billed service.';
 const ctx=await browser.createBrowserContext(),page=await ctx.newPage(),errors=[],writes=[];
 const currentVisit={...visit,status:'signed',signed_at:appointment.ends_at};
 const billing=fixture(patientPath+'/billing',currentVisit,'insured',null,{});
 const claim={...billing.claims[0],patient_id:patient.id,account_id:billing.accounts[0].id,
  status:returned?'rejected':'adjudicated',control_number:returned?'SYN-RETURN':'SYN-APPEAL',
  snapshot:{account:billing.accounts[0],patient}};
 billing.claims=[claim];
 const summary={...billing.summary,claim,state:'denied',insurance:{...billing.summary.insurance,status:'denied'}};
 billing.summary=summary;
 await page.setViewport(viewport);page.setDefaultTimeout(12000);
 const theme=viewport.isMobile?'dark':'light';
 await page.emulateMediaFeatures([{name:'prefers-color-scheme',value:theme}]);
 page.on('pageerror',e=>errors.push(e.message));
 await page.setRequestInterception(true);
 page.on('request',r=>{const u=new URL(r.url()),path=u.pathname;
  if(u.origin!==origin)return r.abort();
  if(r.method()!=='GET'){writes.push({path,body:JSON.parse(r.postData()||'{}')});if(path.endsWith('/denial'))return r.respond({status:200,contentType:'application/json',body:'{}'});return r.abort();}
  let value;
  if(path===patientPath+'/billing')value=billing;
  else if(path===patientPath+'/billing/visit-summary')value=summary;
  else if(path==='/api/v1/billing/provider-settings')value={items:[{id:id(901),verified:true,enabled:true}]};
  else if(path==='/api/v1/billing/claims/'+claim.id)value={claim,tracking:returned?{
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
  assert.match(await page.$eval(summarySelector,n=>n.innerText),/Fix and resend claim/);
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
(async()=>{
 const target=process.env.CHART_TEST_BROWSER?{executablePath:process.env.CHART_TEST_BROWSER}:{channel:'chrome'};
 const browser=await puppeteer.launch({...target,headless:true,pipe:true,args:['--disable-background-networking','--disable-component-update','--no-first-run']});
 try{
  for(const viewport of [{width:1280,height:900},{width:390,height:844,isMobile:true,hasTouch:true}]){
   for(const variant of ['linked-clinician','several-groups','unmatched-clinician'])await check(browser,viewport,variant);
   await checkClaimResponse(browser,viewport);
   await checkClaimResponse(browser,viewport,true);
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
