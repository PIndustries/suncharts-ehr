// SPDX-License-Identifier: AGPL-3.0-only
// Exercises the local UI using synthetic financial data. Every API write is intercepted.
'use strict';
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const {origin,id,staff,patient,appointment,visit,patientPath,fixture,list}=require('./check_encounter_scroll_browser.cjs');

async function check(browser,viewport,scenario){
 const context=await browser.createBrowserContext(),page=await context.newPage(),errors=[],writes=[];
 const insured=scenario==='copay',paid=scenario==='zero',unknown=scenario==='unknown',restricted=scenario==='read-only';
 const selectedVisit=insured?visit:{...visit,status:'signed',signed_at:appointment.ends_at};
 const model=insured?'draft-insured':'paid';
 const data=fixture(patientPath+'/billing',selectedVisit,model,null,{});
 data.copays=[];data.summary.receipts=[];data.summary.patient.unapplied_cents=0;
 Object.assign(data.summary.patient,{copay_cents:2500,copay_paid_cents:0,copay_due_cents:2500,received_cents:0,owes_now_cents:insured||paid?0:unknown?null:6500});
 const payment='[data-encounter-step-number="2"] [data-step-payment]',amount=payment+' [data-payment-summary]';
 const take=payment+' [data-visit-collect]',history='dialog[data-step-payment-details]',other=id(712);
 const readerCase=['online-reader','offline-reader','manual-choice'].includes(scenario);
 const record=id(713);
 let releaseReader,readerRequest;
 const pendingReader=new Promise(resolve=>{releaseReader=resolve;});
 let failBalance=scenario==='failed';
 try{
  page.setDefaultTimeout(10000);await page.setViewport(viewport);
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.setRequestInterception(true);
  page.on('pageerror',err=>errors.push(err.message));
  page.on('request',req=>void (async()=>{
   const url=new URL(req.url()),path=url.pathname;
   if(url.origin!==origin)return req.abort();
   let result;
   if(req.method()!=='GET'){
    writes.push({path,body:JSON.parse(req.postData())});
    assert.equal(path,patientPath+'/billing/copays');assert.equal(req.method(),'POST');
    const body=writes.at(-1).body;
    assert.equal(body.appointment_id,appointment.id);assert.equal(body.amount_cents,insured?2500:6500);
    assert.equal(body.method,'cash');assert.equal(body.received_confirmed,true);
    result={...body,id:record,patient_id:patient.id,version:1,allocated_cents:0};
    data.copays=[result];data.summary.receipts=[{...result,refunded_cents:0,test:false}];
    Object.assign(data.summary.patient,{received_cents:body.amount_cents,copay_due_cents:0,owes_now_cents:0});
   }else if(readerCase&&path.endsWith('/copay-checkouts'))result={items:[],availability:{available:true,livemode:false}};
   else if(readerCase&&path==='/api/v1/billing/payments/readers'){
    if(scenario==='manual-choice'){readerRequest=true;await pendingReader;}
    result={status:'ready',payments_available:true,readers:[{id:id(715),name:'Front desk reader',online:scenario!=='offline-reader'}]};
   }else if(path===patientPath+'/billing')result=data;
   else if(path===patientPath+'/billing/visit-summary'){
    if(failBalance)return req.respond({status:503,contentType:'application/json',body:JSON.stringify({message:'Synthetic unavailable balance'})});
    result=data.summary;
   }
   else if(path===patientPath+'/billing/encounters')result=list([{appointment_id:other,owes_now_cents:9000}]);
   else if(path==='/auth/me'&&restricted)result={...staff,role:'nurse'};
   else if(path.startsWith('/api/')||path.startsWith('/auth/'))result=fixture(path,selectedVisit,model,null,{});
   else if(/^\/$|\.(css|js|png|svg|webp|woff2?|ico)$/.test(path))return req.continue();
   else return req.abort();
   return req.respond({status:200,contentType:'application/json',body:JSON.stringify(result)});
  })().catch(async err=>{errors.push(err.message);if(!req.isInterceptResolutionHandled())await req.abort().catch(()=>{});}));
  await page.evaluateOnNewDocument(()=>localStorage.setItem('suncharts.collectMethod','reader'));
  await page.goto(origin+'/#/patients/'+patient.id+'/encounter/'+visit.id+'/visit',{waitUntil:'load'});
  if(restricted&&!await page.$(payment)){
   await page.waitForFunction(()=>document.getElementById('note-form')?.dataset.visitId===activeVisit?.id);
   assert.equal(await page.$(take),null);assert.deepEqual(writes,[]);console.log('PASS nursing role cannot collect');return;
  }
  const retry=payment+' [data-refresh-revenue]';
  if(scenario==='failed'||scenario==='stale'){
   if(scenario==='stale'){
    await page.waitForFunction(selector=>document.querySelector(selector)?.textContent==='Amount due $65.00',{},amount);
    failBalance=true;
    await page.evaluate(()=>loadEncounterRevenueStatus(encounterChargeAccount(),true));
   }
   await page.waitForFunction((selector,value)=>document.querySelector(selector)?.textContent===value,{},amount,
    scenario==='failed'?'Balance could not be loaded.':'Balance could not be refreshed.');
   assert.equal(await page.$(take),null);
   failBalance=false;
   await page.locator(retry).click();
   await page.waitForFunction(selector=>document.querySelector(selector)?.textContent==='Amount due $65.00',{},amount);
   assert.equal(await page.$(retry),null);assert.ok(await page.$(take));assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
   console.log('PASS '+scenario+' balance recovers from a direct, read-only Retry');return;
  }
  const expected=insured?'Copay due $25.00':paid?'Amount due $0.00':unknown?'Balance pending':'Amount due $65.00';
  await page.waitForFunction((selector,text)=>document.querySelector(selector)?.textContent===text,{},amount,expected);
  assert.equal(await page.$(payment+' details'),null);
  if(paid||unknown||restricted){
   assert.equal(await page.$(take),null);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
   console.log('PASS '+scenario+': '+expected+', no collection');return;
  }
  await page.locator('[data-encounter-step-open="2"]').click();
  await page.locator(take).click();
  const pos='dialog.collect-sheet[open]',target=pos+' [data-collect-target]';
  await page.waitForSelector(pos+' [data-collect-encounter="'+other+'"]',{visible:true});
  assert.equal(await page.$eval(target,el=>el.value),insured?'25.00':'65.00');
  assert.equal(await page.$eval(pos+' [data-collect-encounter="'+other+'"]',el=>el.checked),false);
  assert.equal(await page.$$eval(pos+' [data-collect-method]',els=>els.length),5);
  if(readerCase){
   if(scenario==='manual-choice'){
    await page.waitForSelector(pos+' [data-collect-method="reader"][aria-selected="true"]',{visible:true});
    assert.ok(readerRequest);
    await page.locator(pos+' [data-collect-method="check"]').click();
    releaseReader();await page.waitForNetworkIdle({idleTime:250});
    assert.equal(await page.$eval(pos+' #collect-cash-form',el=>el.dataset.method),'check');
    assert.equal(await page.$(pos+' #reader-copay-form'),null);
   }else{
    const form=pos+(scenario==='online-reader'?' #reader-copay-form':' #collect-cash-form');
    await page.waitForSelector(form,{visible:true});
    assert.equal(await page.$eval(pos,el=>el.dataset.method),scenario==='online-reader'?'reader':'cash');
    assert.equal(await page.evaluate(()=>localStorage.getItem('suncharts.collectMethod')),'reader');
   }
   assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
   console.log('PASS '+scenario+': correct method after availability returns, zero payment writes');return;
  }
  assert.deepEqual(writes,[],'Opening POS never charges a saved card or records a tender');
  await page.waitForSelector(pos+' [data-collect-method="cash"][aria-selected="true"]',{visible:true});
  assert.equal(await page.$eval(pos+' #collect-cash-form [name=amount]',el=>el.value),insured?'25.00':'65.00');
  assert.equal(await page.$eval(target,el=>el.checkVisibility()),false,'One editable cash amount before a split tender');
  await page.locator(pos+' #collect-cash-form [type=submit]').click();
  await page.waitForSelector(pos+' .collect-done',{visible:true});
  assert.equal(writes.length,1);
  assert.equal(await page.evaluate(()=>localStorage.getItem('suncharts.collectMethod')),'reader','A temporary cash fallback preserves the saved reader preference');
  await page.keyboard.press('Escape');await page.waitForSelector(pos,{hidden:true});
  await page.waitForFunction((selector,text)=>document.querySelector(selector)?.textContent===text,{},amount,insured?'Copay due $0.00':'Amount due $0.00');
  await page.locator(payment+' [data-open-encounter-payment-history]').click();
  await page.waitForSelector(history+'[open]',{visible:true});
  await page.waitForSelector(history+' [data-copay-receipt="'+record+'"]',{visible:true});
  await page.evaluate(()=>loadEncounterRevenueStatus(encounterChargeAccount(),true));
  await page.waitForSelector(history+'[open] [data-copay-receipt="'+record+'"]',{visible:true});
  if(!insured){
   const adjustment=history+' [data-new-ledger]',form=history+' [data-encounter-payment-editor] #billing-ledger-form';
   await page.$eval('#encounter-billing-editor',node=>{node.dataset.posBrowserIdentity='same';});
   await page.locator(adjustment).click();
   await page.waitForSelector(form,{visible:true});
   assert.equal(await page.$eval(form,el=>el.dataset.account),data.summary.account.id);
   assert.equal(await page.$eval(form,el=>el.dataset.visit),visit.id);
   assert.equal(await page.$eval(form,el=>el.dataset.version),String(data.summary.account.version));
   assert.equal(await page.$(form+' [name=amount]')!==null,true);
   await page.locator(form+' [data-cancel-billing]').click();
   assert.equal(await page.$(form),null);
   assert.equal(await page.$eval('#encounter-billing-editor',n=>n.dataset.posBrowserIdentity),'same');
   assert.equal(writes.length,1,'Opening or cancelling an adjustment never posts it');
  }
  await page.keyboard.press('Escape');await page.waitForSelector(history+'[open]',{hidden:true});
  assert.deepEqual(errors,[]);
  console.log('PASS '+viewport.width+'px '+scenario+': direct POS, exact initial amount, other encounter opt-in, one cash receipt, zero remaining, history retained');
 }catch(error){console.error(scenario,viewport.width,errors,writes.map(x=>x.path),await page.evaluate(()=>({section:document.querySelector('[data-step-payment]')?.innerText,dialog:document.querySelector('dialog[open]')?.innerText.slice(0,500),notice:document.querySelector('#notice')?.textContent})));throw error;}
 finally{await context.close();}
}
(async()=>{
 const target=process.env.CHART_TEST_BROWSER?{executablePath:process.env.CHART_TEST_BROWSER}:{channel:'chrome'};
 const browser=await puppeteer.launch({...target,headless:true,pipe:true,args:['--disable-background-networking','--no-first-run']});
 try{
  for(const viewport of [{width:1280,height:900},{width:390,height:844,isMobile:true,hasTouch:true}])
   for(const scenario of ['copay','selfpay'])await check(browser,viewport,scenario);
  for(const scenario of ['zero','unknown','read-only','stale','failed','online-reader','offline-reader','manual-choice'])await check(browser,{width:1280,height:900},scenario);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
