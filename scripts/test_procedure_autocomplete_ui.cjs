// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/terminology.js','utf8');
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const item={code:'90001',display:'Synthetic procedure <one>',system:'CPT',edition:'Synthetic 2026',release_id:'release-synthetic',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true};
const tick=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
function fixture(){
 const handlers={},calls=[],timers=new Map(),hosts={};let timerId=0,note=null;
 let response=async path=>path.includes('/codes?')?{items:[item,{...item,code:'90002',display:'Synthetic procedure two'}],release:{id:item.release_id},next_cursor:null}:item;
 const form={isConnected:true,dataset:{patient:'patient-1',id:'account-1',version:'3'},elements:{service_date:{value:'2026-11-07'},visit_id:{value:'visit-1'}}};
 const row={isConnected:true,dataset:{},closest:()=>form,querySelector(selector){if(selector==='[data-terminology-selection]')return note;for(const name of ['code_system','description','code'])if(selector.includes(`[name="${name}"]`))return fields[name];return null;},append(value){note=value;}};
 const fields={};
 function send(type,target,extra={}){let stopped=false;const e={type,target,prevented:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){stopped=true;},...extra};for(const h of handlers[type]||[]){h(e);if(stopped)break;}return e;}
 for(const name of ['code','description','code_system']){
  const attributes={},field={name,value:name==='code_system'?'CPT':name==='code'?'manual':'Manual description',isConnected:true,disabled:false,readOnly:false,
   setAttribute:(k,v)=>attributes[k]=String(v),removeAttribute:k=>delete attributes[k],getAttribute:k=>attributes[k],focus(){},
   matches(selector){return (name!=='code_system'&&selector.includes('[data-procedure-autocomplete]'))||selector.includes(`[name="${name}"]`);},
   closest(selector){if(selector.includes('billing-charge-row'))return row;if(selector==='form')return form;if(selector==='.terminology-combobox')return hosts[name];return null;},
   hasAttribute(){return false;},dispatchEvent(e){send(e.type,field,e);}};
  fields[name]=field;
  if(name!=='code_system'){
   const status={textContent:''},list={id:'list-'+name,innerHTML:'',replaceChildren(){this.innerHTML='';},querySelector(){return {scrollIntoView(){}};}},popup={hidden:true,querySelector:s=>s==='[data-procedure-status]'?status:list};
   hosts[name]={querySelector:s=>({'[data-procedure-popup]':popup,'[data-procedure-results]':list,'[data-procedure-status]':status,'[data-procedure-autocomplete]':field})[s],popup,list,status};
  }
 }
 const context=vm.createContext({Map,Set,WeakMap,WeakSet,Object,Array,Number,String,Date,JSON,URLSearchParams,encodeURIComponent,
  me:{role:'owner'},selected:'patient-1',activeVisit:{id:'visit-1'},workspace:{appointments:[]},chartSection:'visits',encounterSection:'charges',esc,
  document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn),createElement:()=>({dataset:{},remove(){note=null;}})},
  Event:class{constructor(type,options){this.type=type;Object.assign(this,options);}},
  api:async(path,method='GET',body)=>{calls.push({path,method,body});return response(path,method,body);},
  setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
  run:()=>{throw new Error('Autocomplete must not acquire the global busy lock');},console});
 vm.runInContext(source,context);context.fields=fields;context.form=form;context.row=row;
 return {context,fields,form,row,hosts,handlers,calls,timers,send,run:js=>vm.runInContext(js,context),get note(){return note;},setResponse(fn){response=fn;},
  async flush(){const pending=[...timers.values()];timers.clear();for(const timer of pending)timer.fn();await tick();},
  async type(value,name='code'){fields[name].value=value;send('input',fields[name]);await this.flush();}};
}
(async()=>{
 let f=fixture();f.fields.code.value='9';f.send('input',f.fields.code);assert.equal(f.timers.size,0);assert.equal(f.calls.length,0);
 for(const q of ['90','900','9000']){f.fields.code.value=q;f.send('input',f.fields.code);}
 assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].delay,250);assert.equal(f.calls.length,0);await f.flush();assert.equal(f.calls.length,1);
 let params=new URL(f.calls[0].path,'http://fixture').searchParams;assert.equal(params.get('q'),'9000');assert.equal(params.get('system'),'CPT');assert.equal(params.get('service_date'),'2026-11-07');assert.equal(params.get('limit'),'8');assert.equal(params.get('billable'),'true');
 assert.match(f.hosts.code.list.innerHTML,/role="option"/);assert.match(f.hosts.code.list.innerHTML,/Synthetic procedure &lt;one&gt;/);assert.equal(f.fields.code.getAttribute('aria-expanded'),'true');
 assert.equal(f.send('keydown',f.fields.code,{key:'ArrowDown'}).prevented,true);assert.equal(f.fields.code.getAttribute('aria-activedescendant'),'list-code-option-0');
 assert.equal(f.send('keydown',f.fields.code,{key:'Enter'}).prevented,true);await tick();
 assert.equal(f.fields.code.value,item.code);assert.equal(f.fields.description.value,item.display);assert.equal(f.row.dataset.catalogReleaseId,item.release_id);assert.match(f.note.textContent,/Save the charge account/);assert.equal(f.fields.code.getAttribute('aria-expanded'),'false');assert.ok(f.calls.every(c=>c.method==='GET'));
 f=fixture();await f.type('Synthetic procedure','description');params=new URL(f.calls[0].path,'http://fixture').searchParams;assert.equal(params.get('q'),'Synthetic procedure');
 f.send('keydown',f.fields.description,{key:'ArrowUp'});assert.equal(f.fields.description.getAttribute('aria-activedescendant'),'list-description-option-1');
 f.send('keydown',f.fields.description,{key:'Escape'});assert.equal(f.hosts.description.popup.hidden,true);assert.equal(f.fields.description.value,'Synthetic procedure');
 f=fixture();await f.type('900');f.send('keydown',f.fields.code,{key:'ArrowDown'});assert.equal(f.send('keydown',f.fields.code,{key:'Tab'}).prevented,false);assert.equal(f.hosts.code.popup.hidden,true);assert.equal(f.fields.code.value,'900');
 // Responses may arrive after identity, patient, encounter, form, date or row changes.
 for(const mutate of [f=>f.context.selected='patient-2',f=>f.context.me={role:'owner'},f=>f.context.activeVisit={id:'visit-2'},f=>f.context.chartSection='insurance',f=>f.context.encounterSection='note',f=>f.form.dataset.version='4',f=>f.form.dataset.id='account-2',f=>f.form.elements.visit_id.value='visit-2',f=>f.form.elements.service_date.value='2025-01-01',f=>f.fields.code_system.value='HCPCS',f=>f.row.isConnected=false]){
  f=fixture();let finish;f.setResponse(()=>new Promise(resolve=>finish=resolve));await f.type('900');mutate(f);finish({items:[item],release:{id:item.release_id}});await tick();assert.equal(f.hosts.code.list.innerHTML,'');assert.equal(f.fields.code.value,'900');
 }
 f=fixture();let oldResolve;f.setResponse(path=>new URL(path,'http://fixture').searchParams.get('q')==='old'?new Promise(resolve=>oldResolve=resolve):Promise.resolve({items:[item],release:{id:item.release_id}}));
 await f.type('old');await f.type('new');const newest=f.hosts.code.list.innerHTML;oldResolve({items:[{...item,display:'Obsolete result'}],release:{id:item.release_id}});await tick();assert.equal(f.hosts.code.list.innerHTML,newest);
 // A delayed exact-code check must never overwrite newer manual edits or another encounter.
 for(const mutate of [f=>{f.fields.description.value='Manual revision during lookup';},f=>{f.context.activeVisit={id:'visit-2'};},f=>{f.send('keydown',f.fields.code,{key:'Escape'});}]){
  f=fixture();await f.type('900');let finish;f.setResponse(()=>new Promise(resolve=>finish=resolve));f.send('keydown',f.fields.code,{key:'ArrowDown'});f.send('keydown',f.fields.code,{key:'Enter'});mutate(f);finish(item);await tick();assert.equal(f.fields.code.value,'900');assert.equal(f.row.dataset.catalogReleaseId,undefined);
 }
 f=fixture();f.setResponse(async()=>({items:[],release:null}));await f.type('900');assert.match(f.hosts.code.status.textContent,/No usable CPT catalog is installed/);assert.match(f.hosts.code.status.textContent,/authorized catalog/);assert.equal(f.fields.code.value,'900');assert.equal(f.fields.description.value,'Manual description');
 f=fixture();await f.type('900');f.setResponse(async()=>{throw new Error('Catalog permission expired');});f.send('keydown',f.fields.code,{key:'ArrowDown'});f.send('keydown',f.fields.code,{key:'Enter'});await tick();assert.match(f.hosts.code.status.textContent,/entries were kept/);assert.equal(f.row.dataset.catalogReleaseId,undefined);
 f=fixture();f.setResponse(async()=>({items:[{...item,billable:false},{...item,active:false},{...item,effective_end:'2025-01-01'}],release:{id:item.release_id}}));await f.type('900');assert.equal(f.hosts.code.list.innerHTML,'');
 f=fixture();f.fields.code.value='90';f.send('input',f.fields.code,{isComposing:true});assert.equal(f.calls.length,0);assert.equal(f.timers.size,0);f.send('compositionend',f.fields.code);await f.flush();assert.equal(f.calls.length,1);
 f=fixture();f.fields.code.value='900';f.send('input',f.fields.code);f.run('clearTerminologySession()');await f.flush();assert.equal(f.calls.length,0);assert.equal(f.hosts.code.popup.hidden,true);
 f=fixture();await f.type('900');f.context.copy={querySelectorAll:s=>s==='[data-procedure-popup]'?[f.hosts.code.popup]:[f.fields.code]};f.run('clearProcedureAutocompleteMarkup(copy)');assert.equal(f.hosts.code.popup.hidden,true);assert.equal(f.hosts.code.list.innerHTML,'');assert.equal(f.fields.code.getAttribute('aria-expanded'),'false');assert.equal(f.fields.code.value,'900');
 const markup=f.run("terminologyProcedureFields({code:'90001',description:'Synthetic full description'})");assert.match(markup,/role="combobox"/);assert.match(markup,/aria-controls=/);assert.match(markup,/maxlength="10000"/);
 console.log('PASS inline CPT/HCPCS debounce, code/description search, keyboard selection, provenance, stale identity/encounter/account/date guards, manual and license fallback, IME, draft cleanup and no busy lock');
})().catch(error=>{console.error(error);process.exitCode=1;});
