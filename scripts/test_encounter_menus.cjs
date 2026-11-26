// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic DOM fixtures exercise the real menu markup and disclosure handlers.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{JSDOM}=require('jsdom');
const claims=fs.readFileSync('web/claims.js','utf8'),app=fs.readFileSync('web/app.js','utf8');
const handlers=claims.slice(claims.indexOf('function sheetOpen('),claims.indexOf('// Editing a signed note'));
function fixture(content){
 const dom=new JSDOM(`<main id="visit-page-host">${content}</main><button id="outside">Outside</button>`,{runScripts:'outside-only'}),w=dom.window;
 w.esc=value=>String(value);w.matchMedia=()=>({matches:true});
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
 w.eval(handlers);return {dom,w,doc:w.document,page:w.document.getElementById('visit-page-host')};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 const source=app.slice(app.indexOf('function encounterWorkflow(){'),app.indexOf('function encounterVisitActions(){'));
 const header=vm.runInNewContext(source+'\nencounterWorkflow()',{
  workspace:{appointments:[]},activeVisit:{id:'visit',status:'in_progress'},esc:String,
  inRecordArea:()=>false,visitBillingAreaVisible:()=>true,encounterAddMenu:()=>'',encounterDateLabel:()=> 'Synthetic day',
 });
 {
  const f=fixture('<section data-encounter-section=rooming>Rooming</section>'+header+'<section data-step-claim>Claim</section><section data-encounter-step-number=2>Payment</section>'),menu=f.page.querySelector('details'),summary=menu.querySelector('summary');
  for(let i=0;i<2;i++){
   summary.click();assert(menu.open);assert(menu.querySelector('[data-encounter-history-sheet]'));
   assert.equal(f.doc.querySelector('dialog'),null,'More opens a menu containing History, never a sheet');
   assert([...f.page.querySelectorAll('section')].every(n=>!n.hidden),'menus leave every encounter section visible');
   f.doc.getElementById('outside').click();assert(!menu.open);
  }
  summary.click();summary.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert(!menu.open);
  summary.click();const history=menu.querySelector('button');history.addEventListener('click',event=>event.stopPropagation());history.click();assert(!menu.open,'choosing an action closes even when its handler stops propagation');
  f.dom.window.close();
 }
 for(const attrs of ['data-menu','class="frame-add-menu"','class="chart-list-more"','class="patient-banner-more"']){
  const f=fixture(`<details ${attrs}><summary>More ▾</summary><div><a href="#synthetic">Synthetic action</a></div></details>`),menu=f.page.querySelector('details');
  menu.querySelector('summary').click();assert(menu.open);assert.equal(f.doc.querySelector('dialog'),null);
  assert.equal(f.w.detailsSheetOpen(menu),null,'direct calls also exclude menus');
  menu.querySelector('a').click();assert(!menu.open);f.dom.window.close();
 }
 {
  const f=fixture('<form><details data-menu><summary>More ▾</summary><div class="frame-add-items"><button type="submit">Save synthetic form</button></div></details></form>');
  let submits=0;f.page.querySelector('form').addEventListener('submit',event=>{event.preventDefault();submits++;});
  f.page.querySelector('summary').click();f.page.querySelector('button').click();assert.equal(submits,1,'menu actions retain native form submission');f.dom.window.close();
 }
 for(const [label,title] of [['More ▾','Rooming — more'],['▸','Rooming — more'],['Rooming and vitals history ▾','Rooming and vitals history']]){
  const f=fixture(`<section><h3>Rooming</h3><details><summary>${label}</summary><input value="Synthetic value"></details></section>`),details=f.page.querySelector('details'),summary=details.querySelector('summary'),input=details.querySelector('input');
  summary.click();const dialog=f.doc.querySelector('dialog');assert(dialog.open);
  assert.equal(dialog.querySelector('h3').textContent,title);assert.doesNotMatch(title,/[▾▸]/);assert.notEqual(title,'More');
  assert.equal(f.w.detailsSheetOpen(details),dialog,'opening twice reuses the same sheet');assert.equal(f.doc.querySelectorAll('dialog').length,1);assert.equal(dialog.querySelector('input'),input);
  input.value='Edited synthetic value';dialog.querySelector('[data-sheet-close]').click();assert.equal(f.doc.querySelector('dialog'),null);assert.equal(details.querySelector('input'),input);assert.equal(input.value,'Edited synthetic value');
  summary.click();assert.equal(f.doc.querySelector('dialog input'),input,'second opening moves the restored nodes once');
  f.doc.querySelector('dialog').dispatchEvent(new f.w.Event('cancel',{cancelable:true}));assert.equal(details.querySelector('input'),input);f.dom.window.close();
 }
 for(const change of ['page','details','detach','empty']){
  const f=fixture('<section><h3>Rooming</h3><details><summary>History ▾</summary><p>Synthetic history</p></details></section>'),details=f.page.querySelector('details');
  details.querySelector('summary').click();const dialog=f.doc.querySelector('dialog');
  if(change==='page')f.page.innerHTML='<p>Re-rendered synthetic encounter</p>';
  if(change==='details')details.innerHTML='<summary>New history</summary><p>Fresh synthetic history</p>';
  if(change==='detach')details.remove();
  if(change==='empty')dialog.querySelector('.sheet-body').replaceChildren();
  await settle();assert(!dialog.open,`${change} closes the sheet`);assert.equal(f.doc.querySelector('dialog'),null);
  if(change==='details')assert.equal(details.textContent,'New historyFresh synthetic history','stale nodes never overwrite re-rendered content');
  f.dom.window.close();
 }
 {
  const f=fixture('<details><summary>Empty history</summary><div>  </div></details>');f.page.querySelector('summary').click();assert.equal(f.doc.querySelector('dialog'),null,'empty panels never open a sheet');f.dom.window.close();
 }
 // Every arrow-labelled disclosure is explicitly a menu; content panels use descriptive names.
 for(const file of fs.readdirSync('web').filter(name=>name.endsWith('.js'))){
  const source=fs.readFileSync('web/'+file,'utf8');
  for(const match of source.matchAll(/<details([^>]*)><summary>[^<]*▾<\/summary>/g))assert.match(match[1],/data-menu/,file+' must mark its menu');
 }
 const css=fs.readFileSync('web/frame.css','utf8');assert.match(css,/details\[data-menu\]\[open\]>:not\(summary\)\{[^}]*top:calc\(100% \+ 4px\);right:0;left:auto;z-index:100/);assert.match(css,/\.encounter-workspace-heading\{overflow:visible\}/);
 console.log('PASS encounter menus: History dropdown, dismissal, panel titles, node restoration, duplicate open and rerender cleanup');
})().catch(error=>{console.error(error);process.exitCode=1;});
