// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Native DOM controls with synthetic API replies only. Add --browser for real Chromium
// geometry and focus validation. Its profile is temporary.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer-core');
const read=file=>fs.readFileSync('web/'+file,'utf8');
async function main(){
 const realBrowser=process.argv.includes('--browser');
 const profile=realBrowser?fs.mkdtempSync(path.join(require('node:os').tmpdir(),'suncharts-flow-browser-')):null;
 let browser;
 try{
  browser=realBrowser?await puppeteer.launch({executablePath:process.env.CHART_TEST_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile,args:['--no-sandbox']}):domBrowser();
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewport({width:1100,height:750});
  if(realBrowser)await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  // Web Crypto, native dialogs and navigation use the same secure-context rules as the EHR.
  if(realBrowser){
   await page.setRequestInterception(true);
   page.on('request',request=>void request.respond({status:200,contentType:'text/html',body:'<!doctype html>'}));
   await page.goto('http://127.0.0.1/');
  }
  await page.setContent(`<style>.shell-topbar{position:fixed;top:0;height:50px}.frame-content{position:absolute;top:50px;bottom:0;overflow:auto;width:95%}#patient-banner{position:sticky;top:0;height:60px;background:white}textarea{display:block;height:130px}#note-message{position:sticky;bottom:0;background:white}details{padding:8px}</style><header class="shell-topbar">SunCharts</header><main class="frame-content"><div id="chart"><div id="patient-banner">Synthetic Patient</div><div id="visit-page-host"><details open data-encounter-step-number="1"><summary>Visit</summary><section id="encounter-rooming-vitals"><h3>Rooming &amp; vitals</h3><form id="rooming-form"><textarea name="chief_complaint"></textarea><input type="checkbox" name="medications_reviewed"><input type="checkbox" name="allergies_reviewed"></form></section><form id="note-form" data-visit-id="visit" data-version="1">${['subjective','objective','assessment','plan','procedure'].map(k=>`<label>${k}<textarea name="${k}">${k==='objective'||k==='procedure'?'':'Synthetic '+k}</textarea></label>`).join('')}<div id="note-procedure-chips"></div><div id="note-message" role="alert" hidden></div><button type="button" data-action="sign-bill">Sign &amp; bill</button><button type="button" data-action="sign">Sign only</button></form><section data-step-claim><h3>Claim</h3><div id="encounter-billing-editor"></div><div id="review"></div></section></details><details data-encounter-step-number="2"><summary>Payment</summary></details><details data-encounter-step-number="3"><summary>Wrap-up</summary><div id="visit-checkout"></div></details></div></div></main><div id="schedule-panel-copay"></div><div id="schedule-detail"></div><div id="booking"></div>`);
  await page.addStyleTag({content:read('style.css')});
  assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-encounter-step-number]')].map(n=>n.dataset.encounterStepNumber).join(',')),'1,2,3');
  assert.equal(await page.$('[data-step-continue]'),null);
  assert.equal(await page.$eval('[data-action="sign-bill"]',n=>n.closest('[data-encounter-step-number]').dataset.encounterStepNumber),'1');
  await page.evaluate(()=>{
   let syntheticUuid=0;
   if(typeof crypto.randomUUID!=='function')crypto.randomUUID=()=>`00000000-0000-4000-8000-${String(++syntheticUuid).padStart(12,'0')}`;
   window.$=id=>document.getElementById(id);window.esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
   Object.assign(window,{me:{user_id:'clinician',role:'owner'},selected:'patient',patientWorkspaceGeneration:0,chartSection:'visits',activeVisit:{id:'visit',clinician_id:'clinician',status:'in_progress',version:1},workspace:{patient:{id:'patient',given_name:'Synthetic',family_name:'Patient',birth_date:'1990-01-01'},billing:{accounts:[],coverages:[]},appointments:[],visits:[]},noteSectionKeys:['subjective','objective','assessment','plan','procedure'],requests:[],confirmations:0,busy:false,encounterRevenueState:{data:{},review:null}});
   for(const name of ['captureVisitDrafts','updateDraftStatus','refreshEncounterProgress','visitNoteBar','showVisitNoteAuthorship','showVisitDiagnoses','visitNoteSaved','visitReviewRestore','renderChargeEncounterDiagnoses','closeChargeRemovals','chargeSavedFollowUp','showChartSection','chartOpenEditor'])window[name]=()=>{};
   window.run=work=>{window.pending=Promise.resolve().then(work).catch(e=>{window.failure=e.message;throw e;});return pending;};window.notice=message=>window.message=message;
   window.localTime=value=>{const d=new Date(value),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;};window.date=String;window.human=String;window.sourceNotice=()=>'';window.canDraftNote=()=>true;window.canSignNote=()=>true;window.canRecordVisitVitals=()=>false;window.visitBillingAreaVisible=()=>true;
   window.visitDrafts=new Map();window.noteRequestBody=v=>v;window.formData=f=>Object.fromEntries(new FormData(f));window.noteMatchesSaved=(v,s)=>s&&noteSectionKeys.every(k=>v[k]===s[k]);
   window.confirmAction=async()=>{confirmations++;return true;};window.signNextPlan=()=>({done:'Signed'});
   window.rememberVisit=v=>{activeVisit=v;$('note-form').dataset.version=v.version;};window.selectPatient=async()=>{activeVisit=window.signedVisit||activeVisit;};
   window.encounterChargeAccount=()=>workspace.billing.accounts[0]||null;
   window.setEncounterSection=key=>{window.section=key;};window.encounterStepOpen=n=>document.querySelector(`[data-encounter-step-number="${n}"]`)?.setAttribute('open','');
   window.api=async(url,method='GET',body,version)=>{
    requests.push({url,method,body,version});
    if(url.endsWith('/note'))return {...activeVisit,note:body,version:version+1};
    if(url.endsWith('/sign'))return window.signedVisit={...activeVisit,status:'signed',version:version+1};
    if(url.endsWith('/actions')&&body.action==='post')return {...encounterChargeAccount(),status:'posted',version:version+1};
    if(url.endsWith('/checkout/actions'))return {};
    if(url==='/api/v1/practice/visit-types')return {items:[{id:'office',version:1,name:'Office encounter',category:'Office encounter',duration_minutes:30,enabled:true}]};
    if(url.endsWith('/billing/payers'))return {items:[{id:'payer',content:{name:'Synthetic insurer',active:true}}]};
    if(url.endsWith('/coverages'))return {id:'coverage'};
    if(url==='/api/v1/patients/patient')return workspace.patient;
    if(url==='/api/v1/patients'&&method==='POST')return {...body,id:'new-patient'};
    if(url.endsWith('/demographics'))return {content:{phone:'2025550100'}};
    if(url==='/api/v1/patients/new-patient')return {id:'new-patient',given_name:'Synthetic',family_name:'Newpatient'};
    if(url.endsWith('/check-in'))return {};
    if(url.includes('/billing/accounts'))return {...body,id:'account',version:(version||0)+1,status:url.endsWith('/corrections')?'posted':'draft',total_cents:body.content.lines.reduce((n,l)=>n+l.amount_cents,0)};
    throw Error('Unexpected synthetic API '+url);
   };
  });
  const modules=['display-format.js','typeahead.js','billing.js','visit-billing.js','visit-note.js','visit-review.js','checkout.js','patient-picker.js','scheduling.js','schedule-board.js'].map(read).join('\n');
  const app=read('app.js'),start=app.indexOf("    if(['sign','sign-bill'].includes(button.dataset.action)){"),end=app.indexOf('\n  });\n});',start);
  await page.addScriptTag({content:read('clinical.js').split('\n').find(line=>line.startsWith('function selectField('))+'\n'+modules+'\n'+app.slice(app.indexOf('async function saveVisitNote('),app.indexOf('\nlet me, patients'))+`\nwindow.signClick=async button=>{${app.slice(start,end)}};document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>run(()=>signClick(b)));`});
  await page.addScriptTag({content:read('claims.js').slice(read('claims.js').indexOf('function sheetOpen('),read('claims.js').indexOf('// Extra detail on an encounter'))});
  // First press: actual button, red error, focus, and fixed header geometry.
  const before=await page.$eval('#patient-banner',n=>n.getBoundingClientRect().top);
  await page.click('[data-action="sign-bill"]');await page.evaluate(()=>pending);
  assert.equal(await page.$eval('#note-message',n=>n.textContent),'Add Objective before signing.');
  assert.equal(await page.evaluate(()=>document.activeElement.name),'objective');
  if(realBrowser)assert.equal(await page.$eval('[name="objective"]',n=>getComputedStyle(n).outlineStyle),'solid');
  else assert.equal(await page.$eval('[name="objective"]',n=>n.getAttribute('aria-invalid')),'true');
  assert.equal(await page.$eval('#patient-banner',n=>n.getBoundingClientRect().top),before);
  await page.type('[name="objective"]','Synthetic objective');assert.equal(await page.$eval('[name="objective"]',n=>n.hasAttribute('aria-invalid')),false);
  console.log(realBrowser?'PASS browser: first-press SOAP error, red outline, focus and stationary patient header':'PASS native DOM: first-press SOAP error, invalid state and focus');
  // Render real procedure rows, save priced lines, and retain the unpriced line after signing.
  await page.evaluate(()=>{
   $('encounter-billing-editor').innerHTML=`<form id="billing-account-form" data-patient="patient" data-version="0" data-request="synthetic" data-mode="draft" data-autosave="off"><input name="visit_id" value="visit"><input name="service_date" value="2030-11-15"><input name="coverage_id" value=""><textarea name="notes"></textarea>${chargeLinesMarkup([{code_system:'HCPCS',code:'A1234',description:'Synthetic line',units:1,amount_cents:18000},{code_system:'HCPCS',code:'A1235',description:'Synthetic line',units:1,amount_cents:null}],true)}<p data-charge-status></p></form>`;
   const newAccountForm=$('billing-account-form');
   billingChargeDraftSession();newAccountForm.dataset.draftKey=billingChargeKey(null,null,'visit');
   billingChargeBaselines.set(newAccountForm,chargeTableSignature({lines:[]}));captureBillingChargeDraft();
   seedChargeRowAmounts(newAccountForm);visitNoteInlinePaint();
   chargeDraftBody=()=>({content:{visit_id:'visit',service_date:'2030-11-15',currency:'USD',lines:[]},reason:'Synthetic review'});
   visitReviewOpen=()=>{encounterStepOpen(1);};
  });
  assert.equal(await page.evaluate(()=>billingChargeDrafts.has(billingChargeKey(null,null,'visit'))),true,'procedure edits are retained before the new charge account exists');
  assert(await page.$('[data-note-charge-field="amount"]'));
  await page.click('[data-action="sign-bill"]');await page.evaluate(()=>pending);
  assert.equal(await page.evaluate(()=>activeVisit.status),'signed');assert.equal(await page.evaluate(()=>confirmations),0);
  assert.equal(await page.$eval('#rooming-form',n=>!!n.elements.chief_complaint.value||n.elements.medications_reviewed.checked||n.elements.allergies_reviewed.checked),false,'Visit signs with rooming incomplete');
  assert.equal(await page.evaluate(()=>workspace.billing.accounts[0]?.status),'posted');
  assert.equal(await page.evaluate(()=>document.activeElement.name),'amount');
  assert.match(await page.$eval('#billing-account-form',n=>n.textContent),/Add the amount for this line before sending\./);
  console.log('PASS native controls: own note signs without confirm, priced line posts, draft amount remains focused');
  assert.equal(await page.evaluate(()=>visitReviewPendingCharges().length>0),true);
  assert.equal(await page.evaluate(()=>billingChargeDrafts.has(billingChargeKey(null,null,'visit'))),false,'saving a new account retires its unsaved visit draft');
  await page.evaluate(async()=>{
   const form=$('billing-account-form'),row=chargeLiveRows(form)[1],field=row.querySelector('[name="amount"]');
   field.value='45.00';field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
   await saveChargeTable(form);
  });
  assert.equal(await page.evaluate(()=>workspace.billing.accounts[0].total_cents),22500);
  assert.equal(await page.evaluate(()=>workspace.billing.accounts[0].content.lines.length),2);
  assert.equal(await page.evaluate(()=>visitReviewPendingCharges()),'');
  assert.equal(await page.$('[data-sign-price-needed]'),null);
  console.log('PASS native controls: held amount saves as a posted correction without duplicating the priced line');
  // Same native Insurance & copay form in an actual modal; save uses its patient id.
  await page.evaluate(()=>openPatientInsuranceSheet('patient'));
  assert(await page.$('dialog[open] #coverage-form'));assert.equal(await page.evaluate(()=>chartSection),'visits');
  await page.type('#coverage-payer-name','Synthetic');await page.waitForSelector('[data-typeahead-index="0"]');await page.click('[data-typeahead-index="0"]');
  await page.type('#coverage-form [name="member_id"]','SYN-001');
  await page.type('#coverage-form [name="subscriber_name"]','Synthetic Patient');
  await page.type('#coverage-form [name="reason"]','Synthetic insurance registration');
  await page.click('#coverage-form button[type="submit"]');await page.evaluate(()=>pending);
  assert(await page.evaluate(()=>requests.some(r=>r.url==='/api/v1/patients/patient/coverages'&&r.method==='POST')));
  await page.waitForFunction(()=>!document.querySelector('dialog'));
  console.log('PASS native controls: insurance search, modal save and preserved encounter page');
  // Native checkout validation and a single versioned operation.
  await page.evaluate(()=>{
   checkoutContext={patient:selected,visit:activeVisit.id,key:checkoutKey(selected,activeVisit.id)};
   checkoutState={version:4,visit:activeVisit,current_avs:{version:1},events:[{action:'delivery',avs_version:1}],checkout:{completed:false}};
   $('visit-checkout').innerHTML='<form id="checkout-complete-form" data-version="4"><input name="reason" required value="Synthetic visit complete"><button type="submit">Finish encounter</button></form>';
   loadVisitCheckout=async()=>{};
  });
  await page.evaluate(()=>finishVisitEncounter());await page.evaluate(()=>pending);
  assert.equal(await page.evaluate(()=>requests.filter(r=>r.body?.action==='checkout').length),1);
  await page.evaluate(()=>{$('checkout-complete-form').elements.reason.value='';return finishVisitEncounter();});
  assert.equal(await page.evaluate(()=>document.activeElement.name),'reason');
  console.log('PASS native controls: one finish operation when ready; missing wrap-up input highlighted');
  // Self-pay copy uses draft charges, and its insurance card contains only the clear summary/action.
  await page.evaluate(()=>{
   $('encounter-billing-editor').replaceChildren();
   window.draftSummary={charges_cents:18000,state:'post_charges',account:{status:'draft',content:{service_date:'2030-11-15',lines:[]}},insurance:{insured:false},patient:{owes_now_cents:0}};
   $('review').innerHTML=visitBillingTotalsLine(draftSummary)+visitReviewPanelMarkup(draftSummary,{canWrite:true,claimsAllowed:true});
  });
  const selfPay=await page.$eval('#review',n=>n.textContent);
  assert.match(selfPay,/Service lines/);assert.doesNotMatch(selfPay,/insurance|insurer|clearinghouse|copay|Member ID|Priority|Eligibility/i);
  assert.match(await page.$eval('.visit-billing-totals',n=>n.textContent),/Patient will owe\$180.00/);
  console.log('PASS native controls: self-pay service lines and draft patient total');
  // Real booking renderer and payer search, optional coverage API, refreshed demographics phone.
  await page.evaluate(async()=>{
   document.querySelector('.frame-content').hidden=true;
   loadSchedulePatients=async()=>{};schedulePanel=html=>$('booking').innerHTML=html;mountScheduleBookingPatientPicker=()=>{};attachScheduleLocations=async()=>{};
   scheduleProviders=[{id:'clinician',label:'Synthetic Clinician'}];scheduleState={appointments:[{title:'Office visit',category:'Office visit',starts_at:'2030-11-15T09:00:00Z',ends_at:'2030-11-15T09:30:00Z'}]};
   await appointmentEditor(null,null,null,'2030-11-15','2030-11-15T09:00','clinician');
   const form=$('schedule-booking'),block=form.querySelector('[data-booking-new-patient]');block.hidden=false;block.disabled=false;form.dataset.newPatient='1';
   Object.entries({new_given_name:'Synthetic',new_family_name:'Newpatient',new_birth_date:'1990-01-01',new_phone:'2025550100'}).forEach(([k,v])=>form.elements[k].value=v);
  });
  assert.equal(await page.$eval('[data-booking-type] option',n=>n.textContent),'Choose a visit type');
  assert.match(await page.$eval('[data-booking-type]',n=>n.textContent),/Office encounter · 30 min/);
  assert.doesNotMatch(await page.$eval('[data-booking-type]',n=>n.textContent),/Office visit · Office visit/);
  await page.type('#new_insurance-name','Synthetic');await page.waitForSelector('#new_insurance-name-list [data-typeahead-index="0"]');
  await page.$eval('#new_insurance-name-list [data-typeahead-index="0"]',option=>option.click());
  assert.equal(await page.$eval('[name="new_insurance_id"]',field=>field.value),'payer');
  await page.type('[name="new_member_id"]','SYN-NEW');
  await page.evaluate(async()=>{const form=$('schedule-booking');await scheduleCreateBookingPatient(form,Object.fromEntries(new FormData(form)));await scheduleCreateBookingPatient(form,Object.fromEntries(new FormData(form)));});
  assert.equal(await page.evaluate(()=>requests.filter(r=>r.url==='/api/v1/patients/new-patient/coverages').length),1);
  await page.evaluate(()=>{
   window.newAppointment={id:'appointment',patient_id:'new-patient',clinician_id:'clinician',status:'booked',starts_at:'2030-11-15T09:00:00Z',ends_at:'2030-11-15T09:30:00Z'};
   $('booking').innerHTML=schedulePanelHtml(newAppointment,'Synthetic Newpatient',[]);
  });
  assert.match(await page.$eval('#booking',n=>n.textContent),/2025550100/);
  console.log('PASS native controls: booking labels, insurer search/save retry and saved demographics phone');
  await page.evaluate(async()=>{
   scheduleSelected='appointment';scheduleMarkerState.items.set('appointment',{insurance:{status:'self_pay'}});
   scheduleRefreshAfter=async a=>{a.status='checked_in';};await scheduleCheckIn(newAppointment);
  });
  assert.match(await page.$eval('#schedule-panel-copay',n=>n.textContent),/No insurance on file. Self-pay visit\?/);
  const count=await page.evaluate(()=>requests.length);
  await page.$eval('[data-self-pay-dismiss]',button=>button.click());
  assert.equal(await page.evaluate(()=>requests.length),count);assert.equal(await page.$eval('#schedule-panel-copay',n=>n.textContent),'');
  console.log('PASS native controls: self-pay check-in prompt dismisses without a mutation');
  // Mount the continuous encounter itself; navigation scrolls the frame while the header stays fixed.
  if(realBrowser)await page.goto('http://127.0.0.1/');
  await page.setContent(`<style>body{margin:0}.frame-content{position:absolute;inset:0;overflow:auto}#patient-banner{position:sticky;top:0;height:80px;background:white;z-index:30}#visit-editor{min-height:650px}#encounter-rooming-vitals{min-height:150px}[data-step-claim]{min-height:500px}#visit-checkout{min-height:500px}</style><main class="frame-content"><div id="chart"><div id="patient-banner">Synthetic Patient</div><div id="visit-page-host"><div id="visit-editor"><div id="encounter-intake"><div id="encounter-benefits">Synthetic coverage</div><div id="encounter-rooming-vitals">Rooming fields</div></div><div id="encounter-documentation"><form id="note-form"><textarea>Synthetic SOAP</textarea><button type="button" data-action="sign-bill">Sign &amp; bill</button></form></div></div><div id="encounter-revenue"><div id="encounter-revenue-status"><div class="visit-billing-totals"></div><div id="visit-billing-review"><button data-visit-review-send>Send claim</button></div></div></div><div id="visit-checkout"><p>Patient instructions and follow-up</p><button>Finish encounter</button></div></div></div></main>`);
  await page.addStyleTag({content:read('visit-billing.css')});
  await page.evaluate(()=>{
   window.$=id=>document.getElementById(id);window.esc=String;window.money=n=>'$'+(n/100).toFixed(2);
   window.selected='synthetic';window.activeVisit={id:'synthetic',status:'in_progress'};window.workspace={appointments:[]};window.visitBillingDraftSelfPay=()=>false;
   window.encounterRevenueState={data:{summary:{state:'sign_visit',account:{status:'draft'},insurance:{insured:true,status:'not_sent'},patient:{owes_now_cents:2500}}}};
  });
  if(!await page.evaluate(()=>typeof visitBillingReceiptEntries==='function'))await page.addScriptTag({content:read('visit-billing.js')});
  const revenue=read('patient-revenue.js');await page.addScriptTag({content:revenue.slice(revenue.indexOf('function encounterCodesStripMarkup('),revenue.indexOf('function encounterCodesStripClaimSync('))+'\n'+revenue.slice(revenue.indexOf('// One continuous encounter'))});
  await page.evaluate(()=>{
   encounterStepsSync();
   $('note-form').querySelector('button').onclick=()=>{activeVisit.status='signed';encounterRevenueState.data.summary.account.status='posted';encounterStepsSync();};
   document.querySelector('[data-visit-review-send]').onclick=()=>{encounterRevenueState.data.summary.insurance.status='waiting';encounterStepsSync();};
  });
  const header=await page.$eval('#patient-banner',n=>n.getBoundingClientRect().top);
  for(const key of ['2','1']){
   await page.click(`[data-encounter-step-open="${key}"]`);
   assert.equal(await page.evaluate(()=>[...document.querySelectorAll('[data-encounter-step-number],[data-step-claim]')].every(n=>!n.hidden)),true);
   if(realBrowser)assert.equal(await page.$eval('#patient-banner',n=>n.getBoundingClientRect().top),header);
  }
  await page.evaluate(()=>{document.querySelector('.frame-content').scrollTop=250;});
  await page.click('#note-form [data-action="sign-bill"]');
  assert.equal(await page.evaluate(()=>activeVisit.status),'signed');
  assert(await page.$('[data-encounter-claim-status] [data-visit-review-send]'));
  await page.click('[data-encounter-claim-status] [data-visit-review-send]');
  assert.equal(await page.evaluate(()=>encounterRevenueState.data.summary.insurance.status),'waiting');
  assert.equal(await page.$eval('[data-step-payment] [data-visit-collect]',button=>button.textContent),'Take payment');
  if(realBrowser){
   assert.equal(await page.evaluate(()=>window.scrollY),0);
   assert.equal(await page.$eval('.encounter-step-body',n=>getComputedStyle(n).overflow),'visible');
   assert.equal(await page.$eval('#patient-banner',n=>n.getBoundingClientRect().top),header);
  }
  console.log('PASS mounted continuous encounter: two anchors, claim status in Visit, all sections visible, stationary header and sign/send in place');
  assert.deepEqual(errors,[]);
 }finally{if(browser)await browser.close();if(profile)fs.rmSync(profile,{recursive:true,force:true});}
}
function domBrowser(){
 const {JSDOM}=require('jsdom');let dom;
 return {async close(){dom?.window.close();},async newPage(){
  const listeners={};let w;
  const evaluate=(fn,...args)=>w.eval(`(${fn.toString()})(${args.map(v=>JSON.stringify(v)).join(',')})`);
  const wait=async work=>{for(let i=0;i<100;i++){const result=await work();if(result)return result;await new Promise(r=>setTimeout(r,10));}throw Error('DOM wait timed out');};
  return {on(name,fn){listeners[name]=fn;},async setViewport(){},async setContent(html){dom?.window.close();dom=new JSDOM(html,{runScripts:'outside-only',url:'https://synthetic.invalid'});w=dom.window;w.HTMLElement.prototype.scrollIntoView=()=>{};w.HTMLElement.prototype.scrollBy=()=>{};w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.matchMedia=()=>({matches:true});w.addEventListener('error',e=>listeners.pageerror?.(e.error));},
   async addStyleTag({content}){const style=w.document.createElement('style');style.textContent=content;w.document.head.append(style);},
   async addScriptTag({content}){require('node:vm').runInContext(content,dom.getInternalVMContext());},evaluate,
   async $eval(selector,fn){const node=w.document.querySelector(selector);if(!node)throw Error('Missing '+selector);return w.eval(`(${fn.toString()})`)(node);},
   async $(selector){return w.document.querySelector(selector);},
   async click(selector){const node=w.document.querySelector(selector);if(!node)throw Error('Missing '+selector);node.click();},
   async type(selector,text){const node=w.document.querySelector(selector);node.focus();for(const char of text){node.value+=char;node.dispatchEvent(new w.Event('input',{bubbles:true}));}},
   async waitForSelector(selector){return wait(()=>w.document.querySelector(selector));},async waitForFunction(fn){return wait(()=>evaluate(fn));}
  };
 }};
}
main().catch(error=>{console.error(error);process.exitCode=1;});
