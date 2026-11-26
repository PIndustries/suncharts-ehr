// SPDX-License-Identifier: AGPL-3.0-only
// The local EHR shell and chart navigation are real. Synthetic appointment and visit data
// stay in this browser test. Every mutation is matched explicitly and never leaves the test.
'use strict';
const assert=require('node:assert/strict');
const puppeteer=require('puppeteer-core');
const {origin,id,staff,patient,appointment,visit,patientPath,fixture,list}=require('./check_encounter_scroll_browser.cjs');
const office={id:id(503),version:2,name:'Office encounter',category:'Office encounter',duration_minutes:30,enabled:true,diagnoses:[],procedures:[]};
const type={id:id(501),version:4,name:'Spasticity follow-up',category:'Procedure',duration_minutes:45,enabled:true,
 diagnoses:[{code:'G24.9',description:'Synthetic diagnosis'}],procedures:[]};
const chartNav='.frame-chart-navigation';
const groupLabels=['Care tools','Patient chart','Billing','History & records'];
const chartGroup=label=>chartNav+' [data-chart-sidebar-group="'+label+'"]';
const groupToggle=label=>chartGroup(label)+' [data-chart-group-toggle]';
const flyout='[data-chart-group-flyout][open]';

async function verifyCollapsedGroups(page, hasEncounter){
  await page.waitForSelector(chartNav+'[data-sidebar-collapsed=true]',{visible:true});
  const buttons=await page.$$eval(chartNav+' [data-chart-sidebar-group]',groups=>groups.map(group=>{
    const toggle=group.querySelector('[data-chart-group-toggle]');
    const rect=toggle.getBoundingClientRect();
    const icon=[...toggle.querySelectorAll('svg')].find(svg=>svg.checkVisibility());
    return {label:group.dataset.chartSidebarGroup,visible:rect.width>0&&rect.height>0,icon:!!icon};
  }));
  assert.deepEqual(buttons,groupLabels.map(label=>({label,visible:true,icon:true})));
  const destinations=await page.$$eval(chartNav+' .frame-chart-items [data-chart-section],'+chartNav+' .frame-chart-items [data-clinical-focus]',
    buttons=>buttons.filter(b=>b.checkVisibility()&&b.getBoundingClientRect().height>0).map(b=>b.getAttribute('aria-label')));
  assert.deepEqual(destinations,hasEncounter?['Current encounter']:[]);
  assert.equal(await page.$(flyout),null);
}
async function visibleFlyout(page, destination){
  await page.waitForSelector(flyout+' '+destination,{visible:true});
  assert.equal(await page.$$eval(flyout,panels=>panels.length),1);
  const reachable=await page.$eval(flyout+' '+destination,button=>{
    const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
    return r.left>=0&&r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth&&button.contains(hit);
  });
  assert.ok(reachable,'The open chart menu must stay visible and accept a click on its destination');
}
async function keyboardFlyout(page, label, destination){
  const toggle=groupToggle(label);
  await page.focus(toggle);
  if(!await page.$(flyout))await page.keyboard.press('Enter');
  await visibleFlyout(page,destination);
  await page.keyboard.press('Escape');
  await page.waitForSelector(flyout,{hidden:true});
  assert.ok(await page.$eval(toggle,button=>button===document.activeElement),'Escape restores focus to '+label);
}
async function checkRecordRail(page, viewport){
  await page.waitForSelector('#patient-identity-panel:not([hidden])',{visible:true});
  await page.waitForFunction(mrn=>document.querySelector('#patient-identity-panel')?.textContent.includes(mrn),{},patient.mrn);
  await verifyCollapsedGroups(page,false);
  // Touch and mouse must reach the same destinations on an independently opened record.
  const billing=groupToggle('Billing'),insurance='[data-chart-section="insurance"]';
  if(viewport.hasTouch)await page.tap(billing);
  else await page.locator(billing).click();
  await visibleFlyout(page,insurance);
  if(viewport.hasTouch)await page.tap(flyout+' '+insurance);
  else await page.locator(flyout+' '+insurance).click();
  await page.waitForFunction(()=>chartSection==='insurance');
  await page.waitForSelector(flyout,{hidden:true});
  const profile='[data-chart-section="profile"]',chart=groupToggle('Patient chart');
  if(viewport.hasTouch)await page.tap(chart);
  else await page.hover(chart);
  await visibleFlyout(page,profile);
  if(viewport.hasTouch)await page.tap(flyout+' '+profile);
  else await page.locator(flyout+' '+profile).click();
  await page.waitForSelector('#patient-identity-panel:not([hidden])',{visible:true});
  assert.equal(await page.evaluate(()=>location.hash),'#/patients/'+patient.id+'/record');
}

async function check(browser,viewport,role,entry='encounter'){
 const context=await browser.createBrowserContext();
 const page=await context.newPage(),errors=[];
 try{
  await page.setViewport(viewport);page.setDefaultTimeout(12000);
  const today=new Date();today.setHours(0,0,0,0);
  const asAppt=(n,status,minutes)=>({...appointment,id:id(n),status,title:status,starts_at:new Date(today.getTime()+minutes*60000).toISOString(),
    ends_at:new Date(today.getTime()+(minutes+30)*60000).toISOString()});
  const active={...visit,status:'in_progress'},booked=asAppt(402,'booked',0),checked=asAppt(403,'checked_in',0),later=asAppt(404,'booked',2880);
  const appointments=[{...appointment,status:'in_progress'},booked,checked,later],visits=[active];
  const ui={...staff,role,user_id:role==='owner'?staff.user_id:id(502)};
  const writes=[];
  await page.setRequestInterception(true);
  page.on('pageerror',err=>errors.push(err.message));
  page.on('request',request=>void (async()=>{
    const u=new URL(request.url()),path=u.pathname,method=request.method();
    if(u.origin!==origin)return request.abort();
    let data;
    if(method!=='GET'){
      const body=request.postData()?JSON.parse(request.postData()):{};
      writes.push(path);
      if(path==='/api/v1/appointments'&&method==='POST'){
       assert.equal(role,'owner');assert.deepEqual(body.visit_type,{id:type.id,version:type.version});
       assert.equal(body.facility,'Synthetic clinic');assert.equal(body.title,type.name);
       assert.equal(body.category,'Procedure');assert.equal(body.clinician_id,staff.user_id);
       assert.equal(Date.parse(body.ends_at)-Date.parse(body.starts_at),45*60000);
       assert.ok(Math.abs(Date.parse(body.starts_at)-Date.now())<3*60000);
       data={...body,id:id(405),status:'booked',visit_type:type};appointments.push(data);
      }else if(path==='/api/v1/appointments/'+id(405)+'/check-in'&&method==='POST'){
       data=appointments.find(a=>a.id===id(405));data.status='checked_in';
      }else if(path==='/api/v1/visits'&&method==='POST'){
       const appt=appointments.find(a=>a.id===body.appointment_id);
       assert.equal(appt.status,'checked_in');
       data={...visit,id:id(406),encounter_number:8,appointment_id:appt.id,status:'in_progress',note:null};
       appt.status='in_progress';visits.push(data);
      }else throw Error('Unexpected write '+method+' '+path);
    }else if(path==='/auth/me')data=ui;
    else if(path===patientPath+'/identity')data={patient,can_edit:true,version:1,history:[]};
    else if(path===patientPath+'/workspace')data={patient,appointments,visits,amendments:[],flags:[]};
    else if(path==='/api/v1/schedule/locations')data=list([{name:'Synthetic clinic',rooms:[]}]);
    else if(path==='/api/v1/practice/visit-types')data=list([type,office]);
    else if(path===patientPath+'/billing/visit-summary'){
      const v=visits.find(v=>v.id===u.searchParams.get('visit_id'))||active;
      data=fixture(path,v,'blank',null,{});
    }else if(path.includes('/api/v1/visits/')){
      const v=visits.find(v=>v.id===path.split('/')[4])||active;
      if(path==='/api/v1/visits/'+v.id)data=v;
      else if(path.endsWith('/note-authorship'))data={assigned:{id:v.clinician_id,name:staff.display_name},amendments:[]};
      else if(path.endsWith('/rooming'))data={visit:v,status:'not_started',version:v.version,history:[],can_edit:true};
      else if(path.endsWith('/diagnoses'))data={visit:v,diagnoses:[],history:[],version:v.version,can_edit:true};
      else data=fixture(path,active,'blank',null,{});
    }else if(path.startsWith('/api/')||path.startsWith('/auth/'))data=fixture(path,active,'blank',null,{});
    else if(/^\/$|\.(css|js|png|svg|webp|woff2?|ico)$/.test(path))return request.continue();
    else return request.abort();
    return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
   })().catch(async error=>{errors.push(error.message);if(!request.isInterceptResolutionHandled())await request.abort().catch(()=>{});}));
  const patientRoute=origin+'/#/patients/'+patient.id+'/';
  await page.goto(patientRoute+(entry==='record'?'record':'encounter/'+active.id+'/visit'),{waitUntil:'load'});
  if(entry==='record'){
   await checkRecordRail(page,viewport);
   assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
   console.log('PASS '+viewport.width+'px direct patient record: grouped sidebar opens and switches sections');
   return;
  }
  const create='#patient-banner [data-start-encounter-flow="new"]';
  const dialog='dialog[data-encounter-start][open]',form=dialog+' #encounter-start-form';
  await page.waitForFunction(id=>typeof activeVisit!=='undefined'&&activeVisit?.id===id,{},active.id);
  if(role==='front_desk'){
    await page.waitForSelector('#patient-banner');assert.equal(await page.$(create),null);
    assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
    console.log('PASS front desk: no encounter creation action');return;
  }
  await page.waitForSelector(create,{visible:true});
  if(role==='owner'){
   await page.locator('#frame-user-toggle').click();
   const context='#frame-user-panel #frame-build-context';
   await page.waitForSelector(context,{visible:true});
   assert.match(await page.$eval(context+' .frame-build-version',el=>el.innerText),/^Build [0-9]+\./);
   assert.match(await page.$eval(context+' .shell-environment',el=>el.innerText),/development|preview|synthetic data/i);
   const bounds=await page.evaluate(()=>Object.fromEntries(
    ['#frame-user-panel','#frame-user-panel .frame-build-version','#frame-user-toggle'].map(selector=>{
     const {left,right,top,bottom,width}=document.querySelector(selector).getBoundingClientRect();
     return [selector,{left,right,top,bottom,width}];
    })));
   for(const rect of Object.values(bounds))
    assert.ok(rect.left>=0&&rect.right<=viewport.width&&rect.top>=0&&rect.bottom<=viewport.height,
     'The open account menu, build label and launcher fit the viewport: '+JSON.stringify(bounds));
   await page.keyboard.press('Escape');
   await page.waitForSelector('#frame-user-panel',{hidden:true});
   const compactNav=await page.$eval('#frame-chart-select',el=>el.checkVisibility());
   assert.equal(compactNav,viewport.width<=820,'At tablet and phone widths the selector leaves room for the visit');
   if(compactNav){
    assert.equal(await page.$eval('#frame-chart-select',el=>el.selectedOptions[0].textContent),'Current encounter');
    assert.match(await page.$eval('#frame-chart-select',el=>el.textContent),/Encounter history/);
    await page.select('#frame-chart-select','profile');
   }else{
    const nav='.frame-chart-navigation .frame-chart-items';
    assert.equal(await page.$eval(nav+' [aria-pressed=true]',el=>el.getAttribute('aria-label')),'Current encounter');
    const sidebar='#chart [data-chart-sidebar-toggle]';
    await verifyCollapsedGroups(page,true);
    await page.hover(groupToggle('Care tools'));
    await visibleFlyout(page,'[data-chart-section="orders"]');
    await page.hover(flyout+' [data-chart-section="orders"]');
    await visibleFlyout(page,'[data-chart-section="orders"]');
    await page.keyboard.press('Escape');
    await page.waitForSelector(flyout,{hidden:true});
    await page.mouse.move(viewport.width-20,viewport.height-20);
    await keyboardFlyout(page,'Billing','[data-chart-section="insurance"]');
    await keyboardFlyout(page,'Patient chart','[data-clinical-focus="allergy"]');
    const profile=nav+' [data-chart-section="profile"]';
    const profileGroup=await page.$eval(profile,b=>b.closest('[data-chart-sidebar-group]').dataset.chartSidebarGroup);
    await page.locator(groupToggle(profileGroup)).click();
    await visibleFlyout(page,'[data-chart-section="profile"]');
    await page.locator(flyout+' [data-chart-section="profile"]').click();
    await page.waitForFunction(()=>chartSection==='profile');
    await page.waitForSelector(flyout,{hidden:true});
    await page.locator(nav+' [data-chart-section="visits"][aria-label="Current encounter"]').click();
    await page.waitForFunction(()=>chartSection==='visits');
    await page.locator(sidebar).click();
    await page.waitForFunction(()=>parseFloat(getComputedStyle(document.querySelector('#chart')).paddingInlineStart)>=219);
    const collapse=await page.$eval('#chart',n=>parseFloat(getComputedStyle(n).paddingInlineStart));
    const careTools=groupToggle('Care tools');
    if(await page.$eval(careTools,button=>button.getAttribute('aria-expanded')==='false'))await page.locator(careTools).click();
    await page.locator(nav+' [data-chart-section="referrals"]').click();
    await page.waitForFunction(()=>chartSection==='referrals');
    await verifyCollapsedGroups(page,true);
    assert.equal(await page.$eval(nav+' [aria-pressed=true]',button=>button.getAttribute('aria-label')),'Referrals');
    await page.locator(nav+' [data-chart-section="visits"][aria-label="Current encounter"]').click();
    await page.waitForFunction(()=>chartSection==='visits'&&document.querySelector('[data-chart-sidebar-toggle]')?.getAttribute('aria-expanded')==='true');
    await page.waitForFunction(()=>parseFloat(getComputedStyle(document.querySelector('#chart')).paddingInlineStart)>=219);
    await page.locator(sidebar).click();
    await page.waitForFunction(()=>document.querySelector('[data-chart-sidebar-toggle]')?.getAttribute('aria-expanded')==='false');
    const samples=await page.$eval('#chart',async chart=>{
     const widths=[];
     for(let i=0;i<18;i++){await new Promise(requestAnimationFrame);widths.push(parseFloat(getComputedStyle(chart).paddingInlineStart));}
     return widths;
    });
    assert.ok(samples.some(width=>width>52&&width<collapse),'Sidebar moves continuously between widths');
    assert.equal(samples.at(-1),52);
    await page.reload({waitUntil:'load'});
    await page.waitForSelector(sidebar+'[aria-expanded=false]',{visible:true});
    await page.locator(sidebar).click();
    await page.waitForSelector(sidebar+'[aria-expanded=true]',{visible:true});
    await page.reload({waitUntil:'load'});
    await page.waitForSelector(sidebar+'[aria-expanded=true]',{visible:true});
    const records=groupToggle('History & records');
    const billing=groupToggle('Billing');
    await page.locator(billing).click();
    await page.locator(records).click();
    assert.equal(await page.$eval(billing,n=>n.getAttribute('aria-expanded')),'true','Groups expand independently');
    assert.equal(await page.$eval(records,n=>n.getAttribute('aria-expanded')),'true');
    const profileToggle=groupToggle(profileGroup);
    if(await page.$eval(profileToggle,b=>b.getAttribute('aria-expanded')==='false'))await page.locator(profileToggle).click();
    await page.locator(profile).click();
   }
   await page.waitForFunction(()=>chartSection==='profile');
  }
  const original=await page.evaluate(()=>({hash:location.hash,section:chartSection}));
  const open=async()=>{
   const target=await page.$eval(create,button=>{
    const rect=button.getBoundingClientRect();
    return document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button;
   });
   assert.ok(target,'The global navigation must not cover the New encounter button');
   await page.locator(create).click();
   await page.waitForSelector(form+' [name=appointment_id]',{visible:true});
  };
  await open();
  const chooser=form+' [name=appointment_id]';
  assert.equal(await page.$eval(chooser,el=>el.value),checked.id);
  const options=await page.$$eval(chooser+' option',nodes=>nodes.map(node=>node.value));
  assert(!options.includes(appointment.id));
  assert.equal(options.includes(later.id),role==='owner');
  assert.equal(options.includes(''),role==='owner');
  await page.locator(form+' [data-encounter-start-cancel]').click();
  await page.waitForSelector(dialog,{hidden:true});
  assert.deepEqual(await page.evaluate(()=>({hash:location.hash,section:chartSection})),original);
  assert.deepEqual(writes,[]);
  await open();
  if(role==='owner'){
   await page.select(chooser,'');
   const typeSelect=form+' [name=visit_type_id]';
   assert.equal(await page.$eval(typeSelect,el=>el.value),office.id);
   await page.select(typeSelect,'');
   await page.waitForSelector(form+' [data-start-title]',{visible:true});
   await page.select(typeSelect,type.id);
   assert.equal(await page.$eval(form+' [name=duration]',el=>el.value),'45');
   assert.equal(await page.$eval(form+' [data-start-insurance]',el=>el.open),false);
  }
  // A rapid second activation while the first is in flight cannot create a second visit.
  await page.locator(form+' button[type=submit]').click({count:2});
  await page.waitForFunction(visitId=>activeVisit?.id===visitId&&chartSection==='visits',{},id(406));
  await page.waitForSelector(dialog,{hidden:true});
  assert.equal(visits.length,2);
  assert.equal(visits[1].clinician_id,appointment.clinician_id);
  assert.deepEqual(writes,role==='owner'?['/api/v1/appointments','/api/v1/appointments/'+id(405)+'/check-in','/api/v1/visits']:['/api/v1/visits']);
  assert.equal(await page.$eval('#note-form',n=>n.dataset.visitId),id(406));
  if(role==='owner'){
   await page.locator('[data-open-encounter-codes]').click();
   const suggestion='dialog[data-encounter-codes-dialog][open] [data-visit-type-codes]';
   await page.waitForSelector(suggestion,{visible:true});
   assert.match(await page.$eval(suggestion,n=>n.textContent),/G24.9/);
   assert.ok(!writes.some(path=>path.endsWith('/diagnoses')||path.includes('/billing/')),'Choosing the visit type cannot save a diagnosis or a charge');
   assert(!await page.$eval('dialog[data-encounter-codes-dialog][open] #visit-diagnoses-form',form=>[...form.querySelectorAll('[name=code]')].some(input=>input.value==='G24.9')));
  }
  assert.deepEqual(errors,[]);
  console.log(`PASS ${viewport.width}px ${role}: chart header → modal → exact appointment and encounter, with return on cancel.`);
 }catch(error){console.error(viewport.width,role,errors,await page.evaluate(()=>({hash:location.hash,notice:document.querySelector('#notice')?.textContent,dialog:document.querySelector('dialog[open]')?.getAttribute('aria-label')})));throw error;}finally{await context.close();}
}
(async()=>{
 const target=process.env.CHART_TEST_BROWSER?{executablePath:process.env.CHART_TEST_BROWSER}:{channel:'chrome'};
 const browser=await puppeteer.launch({...target,headless:true,pipe:true,args:['--disable-background-networking','--disable-component-update','--no-first-run']});
 try{
  await check(browser,{width:1280,height:900},'owner','record');
  await check(browser,{width:1024,height:900,isMobile:true,hasTouch:true},'owner','record');
  await check(browser,{width:1280,height:900},'owner');
  await check(browser,{width:820,height:1060,isMobile:true,hasTouch:true},'owner');
  await check(browser,{width:390,height:844,isMobile:true,hasTouch:true},'owner');
  await check(browser,{width:1280,height:900},'nurse');
  await check(browser,{width:1280,height:900},'front_desk');
 }finally{await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
