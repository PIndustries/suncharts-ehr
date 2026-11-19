// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The charge line's one procedure box. A charge row carries a single visible type-ahead, not a
// code box and a description box that both search the same list; the code and the description the
// line submits ride on the row as hidden fields, filled by a pick from the list or by a code
// typed by hand as the box is left. This script drives that one box through the handlers
// terminology.js installs on the document, with the same hand-written field stubs the other UI
// scripts use. Every code, description and date below is synthetic.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/terminology.js','utf8');
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const item={code:'90001',display:'Synthetic procedure <one>',system:'CPT',edition:'Synthetic 2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true};
const tick=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
function fixture(){
 const handlers={},calls=[],timers=new Map(),hosts={};let timerId=0,note=null;
 let response=async path=>path.includes('/procedure-codes?')?{items:[]}:path.includes('/codes?')?{items:[item,{...item,code:'90002',display:'Synthetic procedure two'}],release:{id:item.release_id},next_cursor:null}:item;
 const form={isConnected:true,dataset:{patient:'patient-1',id:'account-1',version:'3'},elements:{service_date:{value:'2026-11-07'},visit_id:{value:'visit-1'}}};
 const fields={};
 // The row is the stub the page reads: the one visible box plus the two hidden fields the form
// submits, and the code system the code list decides.
 const row={isConnected:true,dataset:{},closest:()=>form,querySelector(selector){if(selector==='[data-terminology-selection]')return note;if(selector==='[data-terminology-combobox]')return fields.procedure;for(const name of ['code_system','description','code'])if(selector.includes(`[name="${name}"]`))return fields[name];return null;},append(value){note=value;}};
 function send(type,target,extra={}){let stopped=false;const e={type,target,prevented:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){stopped=true;},...extra};for(const h of handlers[type]||[]){h(e);if(stopped)break;}return e;}
 for(const name of ['procedure','code','description','code_system']){
  const attributes={},field={name,value:name==='code_system'?'CPT':name==='code'?'manual':name==='description'?'Manual description':'',isConnected:true,disabled:false,readOnly:false,
   setAttribute:(k,v)=>attributes[k]=String(v),removeAttribute:k=>delete attributes[k],getAttribute:k=>attributes[k],focus(){},
   matches(selector){return (name==='procedure'&&selector.includes('[data-terminology-combobox]'))||selector.includes(`[name="${name}"]`);},
   closest(selector){if(selector.includes('billing-charge-row'))return row;if(selector==='form')return form;if(selector==='.terminology-combobox')return hosts.procedure;return null;},
   hasAttribute(){return false;},dispatchEvent(e){send(e.type,field,e);}};
  fields[name]=field;
 }
 // One popup, belonging to the one box.
 const status={textContent:''},list={id:'list-procedure',innerHTML:'',replaceChildren(){this.innerHTML='';},querySelector(){return {scrollIntoView(){}};}},popup={hidden:true,querySelector:s=>s==='[data-terminology-status]'?status:list};
 hosts.procedure={querySelector:s=>({'[data-terminology-popup]':popup,'[data-terminology-results]':list,'[data-terminology-status]':status,'[data-terminology-combobox]':fields.procedure})[s],popup,list,status};
 const context=vm.createContext({Map,Set,WeakMap,WeakSet,Object,Array,Number,String,Date,JSON,URLSearchParams,encodeURIComponent,
  me:{role:'owner'},selected:'patient-1',activeVisit:{id:'visit-1'},workspace:{appointments:[]},chartSection:'visits',encounterSection:'charges',esc,
  document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),createElement:()=>({dataset:{},remove(){note=null;}})},
  Event:class{constructor(type,options){this.type=type;Object.assign(this,options);}},
  api:async(path,method='GET',body)=>{calls.push({path,method,body});return response(path,method,body);},
  setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
  run:()=>{throw new Error('Autocomplete must not acquire the global busy lock');},console});
 vm.runInContext(source,context);context.fields=fields;context.form=form;context.row=row;
 const box=()=>fields.procedure;
 return {context,fields,box,form,row,hosts,handlers,calls,timers,send,run:js=>vm.runInContext(js,context),get note(){return note;},setResponse(fn){response=fn;},
  async flush(){const pending=[...timers.values()];timers.clear();for(const timer of pending)timer.fn();await tick();},
  async type(value){fields.procedure.value=value;send('input',fields.procedure);await this.flush();},
  // The box and the two fields it fills, read together.
  line(){return {shown:fields.procedure.value,code:fields.code.value,description:fields.description.value};}};
}
(async()=>{
 // Typing a code or a name searches once, debounced, from the one box.
 let f=fixture();f.box().value='9';f.send('input',f.box());assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);
 for(const q of ['90','900','9000']){f.box().value=q;f.send('input',f.box());}
 assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,250);assert.equal(f.calls.length,0);await f.flush();assert.equal(f.calls.length,3,'one search asks the practice codes and both code lists at once');
 const cptCall=()=>new URL(f.calls.find(c=>c.path.includes('system=CPT')).path,'http://fixture').searchParams;
 assert.ok(f.calls.some(c=>c.path==='/api/v1/patients/patient-1/procedure-codes?q=9000'));assert.ok(f.calls.some(c=>c.path.includes('system=HCPCS')));
 let params=cptCall();assert.equal(params.get('q'),'9000');assert.equal(params.get('system'),'CPT');assert.equal(params.get('service_date'),'2026-11-07');assert.equal(params.get('limit'),'8');assert.equal(params.get('billable'),'true');
 assert.match(f.hosts.procedure.list.innerHTML,/role="option"/);assert.match(f.hosts.procedure.list.innerHTML,/Synthetic procedure &lt;one&gt;/);assert.equal(f.box().getAttribute('aria-expanded'),'true');
 // Picking a result fills both submitted fields and shows the line as CODE: description.
 assert.equal(f.send('keydown',f.box(),{key:'ArrowDown'}).prevented,true);assert.equal(f.box().getAttribute('aria-activedescendant'),'list-procedure-option-0');
 assert.equal(f.send('keydown',f.box(),{key:'Enter'}).prevented,true);await tick();
 assert.deepEqual(f.line(),{shown:`${item.code}: ${item.display}`,code:item.code,description:item.display});
 assert.equal(f.row.dataset.catalogReleaseId,item.release_id);assert.match(f.note.textContent,/Save the charge account/);assert.equal(f.box().getAttribute('aria-expanded'),'false');assert.ok(f.calls.every(c=>c.method==='GET'));
 // A name typed into the same box searches the list too, and Escape leaves the typing alone.
 f=fixture();await f.type('Synthetic procedure');params=cptCall();assert.equal(params.get('q'),'Synthetic procedure');
 f.send('keydown',f.box(),{key:'ArrowUp'});assert.equal(f.box().getAttribute('aria-activedescendant'),'list-procedure-option-1');
 f.send('keydown',f.box(),{key:'Escape'});assert.equal(f.hosts.procedure.popup.hidden,true);assert.equal(f.box().value,'Synthetic procedure');
 // Tabbing away from an ambiguous listing keeps the typing and closes the list.
 f=fixture();await f.type('900');f.send('keydown',f.box(),{key:'ArrowDown'});assert.equal(f.send('keydown',f.box(),{key:'Tab'}).prevented,false);assert.equal(f.hosts.procedure.popup.hidden,true);
 // Leaving the box on a code the list answers takes that listing, description and all.
 f=fixture();await f.type('90001');f.send('focusout',f.box(),{relatedTarget:null});await tick();
 assert.deepEqual(f.line(),{shown:`${item.code}: ${item.display}`,code:item.code,description:item.display});assert.equal(f.row.dataset.catalogReleaseId,item.release_id);
 // Leaving it on a code the list has no answer for keeps the code and asks for the description.
 f=fixture();f.setResponse(async()=>({items:[],release:{id:item.release_id}}));await f.type('99213');f.send('focusout',f.box(),{relatedTarget:null});await tick();
 assert.deepEqual(f.line(),{shown:'99213',code:'99213',description:''});
 // Writing 'CODE: description' straight into the box fills both, the way the box shows them.
 f=fixture();f.setResponse(async()=>({items:[],release:{id:item.release_id}}));f.box().value='99213: Synthetic office visit';f.send('input',f.box());await f.flush();f.send('focusout',f.box(),{relatedTarget:null});
 assert.deepEqual(f.line(),{shown:'99213: Synthetic office visit',code:'99213',description:'Synthetic office visit'});
 // Responses may arrive after identity, patient, encounter, form, date or row changes.
 for(const mutate of [f=>f.context.selected='patient-2',f=>f.context.me={role:'owner'},f=>f.context.activeVisit={id:'visit-2'},f=>f.context.chartSection='insurance',f=>f.context.encounterSection='note',f=>f.form.dataset.version='4',f=>f.form.dataset.id='account-2',f=>f.form.elements.visit_id.value='visit-2',f=>f.form.elements.service_date.value='2025-01-01',f=>f.fields.code_system.value='HCPCS',f=>f.row.isConnected=false]){
  f=fixture();let finish;f.setResponse(()=>new Promise(resolve=>finish=resolve));await f.type('900');mutate(f);finish({items:[item],release:{id:item.release_id}});await tick();assert.equal(f.hosts.procedure.list.innerHTML,'');assert.equal(f.line().code,'manual','a late answer changes nothing on the line');
 }
 f=fixture();let oldResolve;f.setResponse(path=>new URL(path,'http://fixture').searchParams.get('q')==='old'?new Promise(resolve=>oldResolve=resolve):Promise.resolve({items:[item],release:{id:item.release_id}}));
 await f.type('old');await f.type('new');const newest=f.hosts.procedure.list.innerHTML;oldResolve({items:[{...item,display:'Obsolete result'}],release:{id:item.release_id}});await tick();assert.equal(f.hosts.procedure.list.innerHTML,newest);
 // A delayed exact-code check must never overwrite newer typing or another encounter.
 for(const mutate of [f=>{f.fields.description.value='Manual revision during lookup';},f=>{f.context.activeVisit={id:'visit-2'};},f=>{f.send('keydown',f.box(),{key:'Escape'});}]){
  f=fixture();await f.type('900');let finish;f.setResponse(()=>new Promise(resolve=>finish=resolve));f.send('keydown',f.box(),{key:'ArrowDown'});f.send('keydown',f.box(),{key:'Enter'});mutate(f);finish(item);await tick();assert.equal(f.line().code,'manual');assert.equal(f.row.dataset.catalogReleaseId,undefined);
 }
 f=fixture();f.setResponse(async()=>({items:[],release:null}));await f.type('900');assert.match(f.hosts.procedure.status.textContent,/No match\. Keep typing, or type the code/);assert.equal(f.box().value,'900');assert.equal(f.fields.description.value,'Manual description');
 f=fixture();await f.type('900');f.setResponse(async()=>{throw new Error('Catalog permission expired');});f.send('keydown',f.box(),{key:'ArrowDown'});f.send('keydown',f.box(),{key:'Enter'});await tick();assert.match(f.hosts.procedure.status.textContent,/entries were kept/);assert.equal(f.row.dataset.catalogReleaseId,undefined);
 f=fixture();f.setResponse(async path=>path.includes('/procedure-codes?')?{items:[]}:({items:[{...item,billable:false},{...item,active:false},{...item,effective_end:'2025-01-01'}],release:{id:item.release_id}}));await f.type('900');assert.equal(f.hosts.procedure.list.innerHTML,'');
 f=fixture();f.box().value='90';f.send('input',f.box(),{isComposing:true});assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);f.send('compositionend',f.box());await f.flush();assert.equal(f.calls.length,3);
 f=fixture();f.box().value='900';f.send('input',f.box());f.run('clearTerminologySession()');await f.flush();assert.equal(f.calls.length,0);assert.equal(f.hosts.procedure.popup.hidden,true);
 f=fixture();await f.type('900');f.context.copy={querySelectorAll:s=>s==='[data-terminology-popup]'?[f.hosts.procedure.popup]:[f.box()]};f.run('clearTerminologyComboboxMarkup(copy)');assert.equal(f.hosts.procedure.popup.hidden,true);assert.equal(f.hosts.procedure.list.innerHTML,'');assert.equal(f.box().getAttribute('aria-expanded'),'false');assert.equal(f.box().value,'900');
 // With no CPT list installed, the practice's own billed codes answer, first, with their billed words;
 // a pick fills the line straight away and needs no code list check. No code system is chosen first.
 f=fixture();f.fields.code_system.value='';f.setResponse(async path=>path.includes('/procedure-codes?')?{items:[{code:'99213',system:'CPT',display:'Synthetic office visit'},{code:'99214',system:'CPT',display:''}]}:path.includes('system=HCPCS')?{items:[{...item,code:'G0001',system:'HCPCS',display:'Synthetic HCPCS'}],release:{id:'r2'}}:{items:[],release:null});
 await f.type('99');assert.equal(f.calls.length,3);assert.match(f.hosts.procedure.list.innerHTML,/<b>99213<\/b> Synthetic office visit<\/span><\/li>/);assert.ok(f.hosts.procedure.list.innerHTML.indexOf('99213')<f.hosts.procedure.list.innerHTML.indexOf('G0001'),'codes starting with what was typed come first');
 f.send('keydown',f.box(),{key:'ArrowDown'});f.send('keydown',f.box(),{key:'Enter'});await tick();
 assert.deepEqual(f.line(),{shown:'99213: Synthetic office visit',code:'99213',description:'Synthetic office visit'});assert.equal(f.fields.code_system.value,'CPT');assert.equal(f.calls.length,3,'no code list check for a practice code');assert.equal(f.hosts.procedure.popup.hidden,true);
 // The practice search failing still leaves the code lists working.
 f=fixture();f.setResponse(async path=>{if(path.includes('/procedure-codes?'))throw new Error('offline');return {items:[item],release:{id:item.release_id}};});await f.type('900');assert.match(f.hosts.procedure.list.innerHTML,/90001/);
 // The markup on screen: one labelled box, and the two names the charge line still submits.
 const markup=f.run("terminologyProcedureFields({code:'90001',description:'Synthetic full description'})");
 assert.match(markup,/role="combobox"/);assert.match(markup,/aria-controls=/);assert.match(markup,/maxlength="10000"/);
 assert.equal((markup.match(/data-terminology-combobox/g)||[]).length,1,'exactly one type-ahead box per charge line');
 assert.match(markup,/>Procedure<\/label>/);assert.match(markup,/placeholder="Type a CPT\/HCPCS code or procedure name"/);
 assert.ok(markup.includes('value="90001: Synthetic full description"'),'a saved line shows CODE: description');
 assert.match(markup,/<input type="hidden" name="code" value="90001"/);assert.match(markup,/<input type="hidden" name="description" value="Synthetic full description"/);
 assert.doesNotMatch(markup,/CPT \/ HCPCS procedure code/,'the second search box is gone');
 console.log('PASS one procedure type-ahead per charge line: debounced code and name search, keyboard selection, CODE: description display, typed-code fill on leaving the box, provenance, stale identity/encounter/account/date guards, manual and license fallback, IME, draft cleanup and no busy lock');
})().catch(error=>{console.error(error);process.exitCode=1;});
