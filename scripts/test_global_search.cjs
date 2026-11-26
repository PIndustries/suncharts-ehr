// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Small event-capable DOM fixture; exercises the actual shell implementation.
class Node {
 constructor(tag='div',attrs={}){this.tagName=tag.toUpperCase();this.attrs=attrs;this.id=attrs.id||'';this.dataset={};for(const[k,v]of Object.entries(attrs))if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;this.events={};this.children=[];this.isConnected=true;this.value='';this.classList={add(){},contains(){return false;}};}
 addEventListener(type,fn){(this.events[type]??=[]).push(fn);}
 emit(type,event={}){event.target??=this;event.preventDefault??=()=>{event.prevented=true;};event.stopImmediatePropagation??=()=>{};for(const fn of this.events[type]||[])fn(event);return event;}
 set innerHTML(html){this.html=html;this.children=[];const pattern=/<(input|div|p|button|section)\b([^>]*)>/g;for(const match of html.matchAll(pattern)){const attrs={};for(const a of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))attrs[a[1]]=a[2]??'';this.children.push(new Node(match[1],attrs));}}
 get innerHTML(){return this.html||'';}
 matches(selector){if(selector[0]==='#')return this.id===selector.slice(1);if(selector==='button')return this.tagName==='BUTTON';const attr=selector.match(/^\[([^\]]+)\]$/);return !!attr&&Object.hasOwn(this.attrs,attr[1]);}
 querySelectorAll(selector){return this.children.flatMap(c=>[...(c.matches(selector)?[c]:[]),...c.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 closest(selector){return this.matches(selector)?this:null;}
 hasAttribute(key){return Object.hasOwn(this.attrs,key);}
 setAttribute(k,v){this.attrs[k]=v;}
 removeAttribute(k){delete this.attrs[k];}
 replaceChildren(){this.children=[];this.html='';}
 focus(){this.focused=true;}
 scrollIntoView(){}
 append(node){this.children.push(node);}
}
function fixture(){
 const nodes=new Map(),calls=[],timers=new Map();let nextTimer=0,dialog,panel;
 const node=id=>{if(!nodes.has(id))nodes.set(id,new Node(id==='shell-find-patient'?'button':'div',{id}));return nodes.get(id);};
 const document=new Node();document.createElement=tag=>new Node(tag);
 const ctx={document,navigator:{platform:'MacIntel'},MutationObserver:class{observe(){}},Date,URLSearchParams,me:{tenant_id:'synthetic',user_id:'staff',role:'owner'},$:node,console,
 esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),canRegisterPatient:()=>true,
 setTimeout(fn,ms){assert.equal(ms,150);const id=++nextTimer;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
 sheetOpen(title,body){calls.push(['sheet',title]);panel=body;dialog=new Node('dialog');dialog.children.push(body);return dialog;},
 sheetClose(d){d.isConnected=false;d.emit('close');calls.push(['close']);},run:fn=>{const p=Promise.resolve().then(fn);calls.push(['run',p]);return p;},
 api:async path=>{calls.push(['api',path]);return {groups:[{key:'patients',label:'Patients',offset:0,more:true,items:[{id:'p1',patient_id:'p1',kind:'patients',title:'Synthetic Avery',detail:'1990-01-01 · SYN-1'}]},{key:'claims',label:'Claims',offset:0,more:false,items:[{id:'c1',patient_id:'p1',kind:'claims',title:'SYN-CLAIM',detail:'Synthetic Payer'}]}]};},
 showClinical:async()=>calls.push(['clinical']),selectPatient:async id=>{calls.push(['patient',id]);ctx.selected=id;ctx.workspace={visits:[],labs:{orders:[]},billing:{accounts:[]}};},showClaimsWorkspace:async()=>calls.push(['claims-workspace']),showClaim:async id=>calls.push(['claim',id]),scheduleDate:'2026-11-25',showSchedule:async()=>calls.push(['schedule']),showPatientBillingWorkspace:async()=>calls.push(['billing']),showBillingOrganizations:async()=>calls.push(['billing-setup']),appointmentEditor:async()=>calls.push(['new-appointment']),closeNavigation(){},
 };
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/shell.js','utf8'),ctx);
 async function settle(){for(let i=0;i<8;i++)await Promise.resolve();}
 return {ctx,node,calls,document,get panel(){return panel;},get dialog(){return dialog;},async open(){node('shell-find-patient').emit('click');await settle();},async type(value){const input=panel.querySelector('[data-global-query]');input.value=value;input.emit('input');for(const[id,fn]of [...timers]){timers.delete(id);await fn();}await settle();},settle,timers};
}
const tests=[];const test=(name,fn)=>tests.push([name,fn]);
test('header click opens one focused search panel; focus and Enter use the same panel',async()=>{
 const f=fixture();await f.open();assert.equal(f.calls.filter(c=>c[0]==='sheet').length,1);assert(f.panel.querySelector('[data-global-query]').focused);
 f.document.emit('keydown',{key:'Enter',target:f.node('shell-find-patient')});await f.settle();assert.equal(f.calls.filter(c=>c[0]==='sheet').length,1);
});
test('Command K and Control K open search and Escape closes',async()=>{
 for(const modifier of ['metaKey','ctrlKey']){const f=fixture(),event=f.document.emit('keydown',{key:'k',[modifier]:true});await f.settle();assert(event.prevented);assert(f.dialog.isConnected);f.dialog.emit('keydown',{key:'Escape'});assert(!f.dialog.isConnected);}
});
test('global search shortcut respects blocking dialogs',async()=>{
 const f=fixture();
 f.node('app').setAttribute('inert','');
 const event=f.document.emit('keydown',{key:'k',metaKey:true});
 await f.settle();
 assert(!event.prevented);
 assert(!f.dialog);
});
test('debounce and minimum length prevent stale choices; results are grouped',async()=>{
 const f=fixture();await f.open();await f.type('s');assert(!f.calls.some(c=>c[0]==='api'));
 const input=f.panel.querySelector('[data-global-query]');input.value='sy';input.emit('input');input.value='syn';input.emit('input');assert.equal(f.timers.size,1);await f.type('synthetic');
 const results=f.panel.querySelector('#global-search-results');assert.match(results.innerHTML,/<h3>Patients<\/h3>/);assert.match(results.innerHTML,/<h3>Claims<\/h3>/);assert.match(results.innerHTML,/Show all patients/);
 input.value='';input.emit('input');assert.equal(results.innerHTML,'');f.dialog.emit('keydown',{key:'Enter',target:input});await f.settle();assert(!f.calls.some(c=>c[0]==='patient'));
});
test('arrows highlight across groups, Enter opens the target claim',async()=>{
 const f=fixture();await f.open();await f.type('syn');const input=f.panel.querySelector('[data-global-query]');
 assert.equal(input.attrs['aria-activedescendant'],'global-choice-0');
 f.dialog.emit('keydown',{key:'ArrowDown',target:input});assert.equal(input.attrs['aria-activedescendant'],'global-choice-1');
 f.dialog.emit('keydown',{key:'ArrowUp',target:input});assert.equal(input.attrs['aria-activedescendant'],'global-choice-0');
 f.dialog.emit('keydown',{key:'ArrowDown',target:input});
 f.dialog.emit('keydown',{key:'Enter',target:input});await f.settle();assert(f.calls.some(c=>c[0]==='claim'&&c[1]==='c1'));assert(!f.dialog.isConnected);
});
test('mouse choice opens the exact patient chart',async()=>{
 const f=fixture();await f.open();await f.type('syn');const results=f.panel.querySelector('#global-search-results');results.emit('click',{target:results.querySelector('[data-global-choice]')});await f.settle();assert.deepEqual(f.calls.filter(c=>['clinical','patient'].includes(c[0])),[['patient','p1']]);
});
test('Show all pages only its group, with five results per page',async()=>{
 const f=fixture();await f.open();await f.type('syn');const results=f.panel.querySelector('#global-search-results');results.emit('click',{target:results.querySelector('[data-global-more]')});await f.settle();assert(f.calls.some(c=>c[0]==='api'&&/group=patients/.test(c[1])&&/offset=1/.test(c[1])));
});
test('empty results offer New patient and escape typed markup',async()=>{
 const f=fixture();f.ctx.api=async()=>({groups:[]});await f.open();await f.type('<synthetic>');assert.match(f.panel.querySelector('[data-global-status]').textContent,/Nothing matches “<synthetic>”/);assert.match(f.panel.querySelector('#global-search-results').innerHTML,/New patient/);
});
test('a late response after account switch cannot display records',async()=>{
 const f=fixture();let resolve;f.ctx.api=()=>new Promise(r=>resolve=r);await f.open();const input=f.panel.querySelector('[data-global-query]');input.value='syn';input.emit('input');const pending=[...f.timers.values()][0]();f.ctx.me={tenant_id:'other'};resolve({groups:[{key:'patients',label:'Patients',items:[{title:'Hidden'}]}]});await pending;assert.equal(f.panel.querySelector('#global-search-results').innerHTML,'');
});
test('every nonpatient record kind routes to an existing detail screen',async()=>{
 for(const kind of ['files','encounters','appointments','payments','orders','referrals']){
  const f=fixture();let opened=false;
  f.ctx.api=async path=>{if(path.includes('/appointments/'))return {starts_at:'2026-11-25T14:00:00Z'};if(path.includes('/visits/'))return {id:'record',patient_id:'p1'};if(path.includes('/copay-receipts/'))return {receipt:{appointment_id:'ap1'}};if(path.endsWith('/orders'))return {orders:[{id:'record'}]};return {id:'record'};};
  Object.assign(f.ctx,{renderDocuments:async()=>{},showChartSection(){},documentStates:new Map([['p1',{items:[]}]]),openDocumentFile:async id=>{opened=id;},openPatientEncounter:async id=>{opened=id;},scheduleDayKey:()=> '2026-11-25',appointmentDetail:async id=>{opened=id;},showCopayReceipt:async id=>{opened=id;},showOrder:id=>{opened=id;},renderReferrals:async()=>{},referralStates:new Map([['p1',{items:[]}]]),showReferrals(){}});
  f.node('referral-record-record').content={cloneNode(){opened='record';return new Node();}};
  await f.ctx.openGlobalSearchResult({kind,id:'record',patient_id:'p1'});assert.equal(opened,'record',kind);
 }
});
(async()=>{let failed=0;for(const[name,fn]of tests){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}if(failed)process.exitCode=1;})();
