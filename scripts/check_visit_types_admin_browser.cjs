// SPDX-License-Identifier: AGPL-3.0-only
// Uses the preview's real interface with intercepted, synthetic API responses.
'use strict';
const assert=require('node:assert/strict'),puppeteer=require('puppeteer-core');
const origin=new URL(process.env.ENCOUNTER_TEST_URL||'http://127.0.0.1:8095').origin;
assert.match(origin,/^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const base='/api/v1/practice/visit-types',id='00000000-0000-4000-8000-000000000123';
const staff={user_id:'00000000-0000-4000-8000-000000000021',tenant_id:'00000000-0000-4000-8000-000000000022',role:'owner',display_name:'Synthetic owner'};
const codeRows=[
 {code:'M54.2',display:'Synthetic diagnosis',system:'ICD-10-CM'},
 {code:'99213',display:'Synthetic procedure',system:'CPT',default_units:2,modifiers:'25'}
];
async function check(browser,width){
 const context=await browser.createBrowserContext(),page=await context.newPage();
 const rows=[],writes=[],errors=[];let simulateConflict=false;
 page.setDefaultTimeout(7000);
 await page.setViewport({width,height:850});
 await page.setRequestInterception(true);
 page.on('pageerror',err=>errors.push(err.message));
 page.on('request',req=>{
  const url=new URL(req.url()),method=req.method(),path=url.pathname;
  if(url.origin!==origin)return void req.abort();
  if(!/^\/(auth|api)\//.test(path))return void req.continue();
  let status=200,body={items:[],appointments:[],blocks:[],providers:[],events:[],forms:[],history:[],orders:[],reviews:[]};
  if(path==='/auth/me')body=staff;
  else if(path==='/auth/mode')body={mode:'local'};
  else if(path==='/api/v1/practice/code-sets')body={items:codeRows.map(row=>({system:row.system,enabled:true}))};
  else if(path==='/api/v1/practice/codes')body={items:codeRows.filter(row=>row.code===url.searchParams.get('q')?.toUpperCase()&&row.system==='CPT')};
  else if(path==='/api/v1/terminology/codes')body={items:codeRows.filter(row=>row.code===url.searchParams.get('q')?.toUpperCase()&&row.system===url.searchParams.get('system')).map(row=>({...row,release_id:id,active:true,billable:true}))};
  else if(path===base&&method==='GET')body={items:rows.filter(row=>row.enabled||url.searchParams.get('include_disabled')==='true')};
  else if(path===base&&method==='POST'){body={...JSON.parse(req.postData()),id,version:1};rows.push(body);writes.push({method,body});}
  else if(path===base+'/'+id&&method==='PUT'){
   const version=Number(req.headers()['if-match']?.replaceAll('"',''));
   if(simulateConflict||version!==rows[0].version){simulateConflict=false;status=409;body={message:'The visit type changed. Refresh before saving.'};}
   else {body={...JSON.parse(req.postData()),id,version:version+1};rows[0]=body;writes.push({method,body,version});}
  }else if(method!=='GET'){errors.push('Unexpected '+method+' '+path);return void req.abort();}
  return void req.respond({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 try{
  await page.goto(origin+'/#/practice');
  const tab='[data-admin-tab="visit-types"]',form='#practice-visit-type-form';
  await page.locator(tab).click();
  await page.locator('[data-visit-type-new]').click();
  await page.locator(form+' [name=name]').fill('Synthetic injection visit');
  await page.locator(form+' [name=duration_minutes]').fill('37');
  assert.deepEqual(await page.$$eval('#visit-type-minutes option',rows=>rows.map(row=>row.value)),['15','20','30','45','60']);
  await page.locator(form+' [name=duration_minutes]').fill('481');
  assert.equal(await page.$eval(form,f=>f.checkValidity()),false);
  await page.locator(form+' [name=duration_minutes]').fill('37');
  await page.locator('#visit-type-diagnoses').fill('does not match');
  await page.locator(form+' [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('[data-visit-type-status]')?.textContent.includes('Select a matching code'));
  assert.equal(writes.length,0);
  for(const [key,code] of [['diagnoses','M54.2'],['procedures','99213']]){
   await page.locator('#visit-type-'+key).fill(code);
   await page.locator('#visit-type-'+key+'-list [role=option]').click();
   await page.waitForFunction((key,code)=>document.querySelector('[data-visit-type-codes="'+key+'"]').textContent.includes(code),{},key,code);
  }
  await page.locator(form+' [type=submit]').click();
  await page.waitForSelector(form,{hidden:true});
  await page.waitForSelector('[data-visit-type-edit]',{visible:true});
  assert.equal(rows[0].duration_minutes,37);
  assert.deepEqual(rows[0].diagnoses,[{code:'M54.2',description:'Synthetic diagnosis'}]);
  assert.deepEqual(rows[0].procedures,[{code_system:'CPT',code:'99213',description:'Synthetic procedure',units:2,modifiers:'25'}]);
  assert.equal(Object.hasOwn(rows[0].procedures[0],'price_cents'),false);
  await page.locator('[data-visit-type-edit]').click();
  await page.locator(form+' [name=duration_minutes]').fill('45');
  await page.locator('[data-remove-visit-code=diagnoses]').click();simulateConflict=true;
  await page.locator(form+' [type=submit]').click();
  await page.waitForFunction(()=>document.querySelector('[data-visit-type-status]')?.textContent.includes('changed'));
  assert.equal(await page.$eval(form+' [name=duration_minutes]',n=>n.value),'45');assert.equal(writes.length,1);
  await page.locator(form+' [data-sheet-close]').click();
  await page.waitForSelector(form,{hidden:true});
  await page.locator(tab).click();await page.locator('[data-visit-type-edit]').click();
  await page.locator(form+' [name=duration_minutes]').fill('45');
  await page.locator('[data-remove-visit-code=diagnoses]').click();
  await page.locator(form+' [type=submit]').click();
  await page.waitForSelector(form,{hidden:true});
  assert.equal(rows[0].duration_minutes,45);assert.deepEqual(rows[0].diagnoses,[]);assert.equal(writes.at(-1).version,1);
  await page.locator('[data-visit-type-toggle]').click();
  await page.locator('[data-dialog-confirm]').click();
  await page.waitForSelector('[data-visit-types] details');
  assert.equal(rows[0].enabled,false);
  await page.locator('[data-visit-types] summary').click();
  await page.locator('[data-visit-type-toggle]').click();await page.locator('[data-dialog-confirm]').click();
  await page.waitForSelector('[data-visit-types] details',{hidden:true});
  assert.equal(rows[0].enabled,true);assert.equal(writes.length,4);assert.equal(rows[0].procedures.length,1);
  assert.deepEqual(errors,[]);
  console.log(width+'px: owner created, edited, retired and restored a visit type. Catalog selection, custom duration, duplicate-source match and version conflicts verified.');
 }finally{await context.close();}
}
(async()=>{const target=process.env.CHART_TEST_BROWSER?{executablePath:process.env.CHART_TEST_BROWSER}:{channel:'chrome'};const browser=await puppeteer.launch({...target,headless:true,pipe:true,args:['--disable-background-networking','--no-first-run']});try{for(const width of [1280,390])await check(browser,width);}finally{await browser.close();}})().catch(err=>{console.error(err);process.exitCode=1;});
