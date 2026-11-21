// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}

const terminology=fs.readFileSync('web/terminology.js','utf8'),diagnoses=fs.readFileSync('web/visit-diagnoses.js','utf8');
const dx={code:'E11.9',display:'Type 2 diabetes mellitus without complications',system:'ICD-10-CM',edition:'2026',release_id:'release-dx',effective_start:'2026-01-01',effective_end:'2026-12-31',billable:true,active:true,source_name:'Synthetic public source'};
const hemi={...dx,code:'G82.21',display:'Spastic hemiplegia'};
function detailFor(code){const base=[dx,hemi].find(item=>item.code===code)||dx;return {...base,code};}
const tick=async()=>{for(let n=0;n<16;n++)await Promise.resolve();await new Promise(setImmediate);};
function fixture(data={version:3,visit:{id:'v1',version:3,status:'in_progress'},can_edit:true,diagnoses:[],history:[],history_truncated:false}){
 let html='',form=null,tree={rows:[]};const handlers={},timers=new Map();let timerId=0,respondImpl=(path,method,body,version)=>path.includes('/codes?')?{items:[dx,hemi],release:{id:dx.release_id},next_cursor:null}:path.includes('/releases/')?detailFor(decodeURIComponent(path.split('/codes/')[1]||'')):{...data};
 const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');
 const created=[],badge={textContent:''};
 const host={textContent:'',querySelector:sel=>sel==='[data-diagnosis-rebase]'||sel==='[data-diagnosis-unsaved]'?null:sel==='.section-head .badge'?badge:null,get innerHTML(){return html;},set innerHTML(value){
  html=value;const rows=[];
  for(const part of value.split('<div class="amendment" data-diagnosis-row').slice(1)){
   const code=decode((part.match(/name="code" type="text" value="([^"]*)"/)||[])[1]||''),display=decode((part.match(/name="display" type="text" value="([^"]*)"/)||[])[1]||'');
   const entry={status:{textContent:''},list:{id:'list-'+rows.length,innerHTML:'',replaceChildren(){this.innerHTML='';},querySelector(){return {scrollIntoView(){}};}},popup:{hidden:true},note:null,saved:null};
   entry.popup.querySelector=sel=>sel==='[data-terminology-status]'?entry.status:entry.list;
   entry.host={querySelector:sel=>sel==='[data-terminology-combobox]'?entry.code:sel==='[data-terminology-popup]'?entry.popup:sel==='[data-terminology-results]'?entry.list:sel==='[data-terminology-status]'?entry.status:null};
   const makeField=name=>{
    const attributes={'data-terminology-combobox':'','data-terminology-scope':'diagnosis','data-terminology-system':'ICD-10-CM'};
    const field={name,value:name==='code'?code:display,isConnected:true,disabled:false,readOnly:false,
     setAttribute:(k,v)=>attributes[k]=String(v),removeAttribute:k=>delete attributes[k],getAttribute:k=>attributes[k]??null,focus(){},
     matches:sel=>sel.includes('[data-terminology-combobox]')||sel.includes(`[name="${name}"]`),
     closest:sel=>sel==='.terminology-combobox'?entry.host:sel.includes('data-diagnosis-row')?entry.row:sel==='#visit-diagnoses-form'||sel==='form'?form:null,
     hasAttribute:k=>k in attributes,dispatchEvent(e){e.target=field;for(const h of handlers.input||[])h(e);}};
    return field;
   };
   entry.code=makeField('code');entry.display=makeField('display');
   entry.row={isConnected:true,matches:sel=>sel.includes('data-diagnosis-row'),dataset:{},
    querySelector:sel=>{if(sel==='[data-terminology-selection]')return entry.note;if(sel.includes('[name="code"]'))return entry.code;if(sel.includes('[name="display"]'))return entry.display;return null;},
    append(node){entry.note=node;},closest:sel=>sel==='form'?form:null};
   rows.push(entry);
  }
  tree={rows};
  const match=value.match(/<form id="visit-diagnoses-form" data-visit-id="([^"]+)" data-patient-id="([^"]+)" data-version="([^"]+)"/);
  if(!match){if(form)form.isConnected=false;form=null;return;}
  form={id:'visit-diagnoses-form',isConnected:true,closest:sel=>sel==='#visit-diagnoses-form'?host:null,insertAdjacentElement:(pos,node)=>{if(tree.rows.length)tree.rows[tree.rows.length-1].saved=node;},
   dataset:{visitId:decode(match[1]),patientId:decode(match[2]),version:match[3]},
   querySelectorAll:sel=>sel.includes('data-diagnosis-row')?tree.rows.map(entry=>entry.row):[],
   elements:{reason:{value:decode((value.match(/name="reason" value="([^"]*)"/)||[])[1]||'')}}};
  form.querySelector=sel=>sel.includes('[name="reason"]')?{value:form.elements.reason.value}:null;
 }};
 const send=(type,target,extra={})=>{let stopped=false;const e={type,target,prevented:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){stopped=true;},...extra};for(const h of handlers[type]||[]){h(e);if(stopped)break;}return e;};
 const calls=[];
 const context=vm.createContext({window:{},console,Map,Set,WeakMap,WeakSet,Object,Array,Number,String,JSON,Promise,URLSearchParams,encodeURIComponent,setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),Event:class{constructor(type,options){this.type=type;Object.assign(this,options);}},selected:'p1',me:{user_id:'c1',role:'clinician'},activeVisit:{id:'v1',version:3,status:'in_progress',appointment_id:'appt-1',created_at:'2026-11-07T14:00:00Z'},chartSection:'visits',encounterSection:'clinical',workspace:{appointments:[{id:'appt-1',starts_at:'2026-11-07T14:00:00Z'}]},localTime:v=>String(v).slice(0,16),confirmAction:async()=>true,$:id=>id==='visit-diagnoses'?host:id==='visit-diagnoses-form'?form:null,api:(path,method='GET',body,version)=>{calls.push({path,method,body,version});try{return respondImpl(path,method,body,version);}catch(err){return Promise.reject(err);}},date:s=>s,esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),run:fn=>{context.pending=fn();return context.pending;},captureVisitDrafts:()=>{},rememberVisit:v=>{if(context.activeVisit&&v.visit)Object.assign(context.activeVisit,v.visit);},refreshEncounterProgress:()=>{},notice:m=>{context.notices=[...(context.notices||[]),m];},document:{addEventListener:(name,fn)=>{(handlers[name]??=[]).push(fn);},createElement:()=>{const node={dataset:{},className:'',attributes:{},setAttribute(k,v){node.attributes[k]=v;},remove(){},textContent:''};created.push(node);return node;}}});
 context.calls=calls;
 vm.runInContext(terminology,context);vm.runInContext(diagnoses,context);
 return {context,created,calls,host,handlers,timers,data,get form(){return form;},get rows(){return tree.rows;},
  run:code=>vm.runInContext(code,context),send,setResponse(fn){respondImpl=fn;},
  async render(){await vm.runInContext('renderVisitDiagnoses()',context);await tick();},
  field(index,name){return tree.rows[index][name];},
  note(index=0){return tree.rows[index].note;},
  click(name,value=''){const attribute='data-diagnosis-'+name,key='diagnosis'+name[0].toUpperCase()+name.slice(1),button={dataset:{[key]:String(value)},hasAttribute:n=>n===attribute,closest:()=>null};for(const handler of handlers.click)handler({target:{closest:()=>button},preventDefault(){},stopImmediatePropagation(){}});return context.pending;},
  async flush(){const pending=[...timers.values()];timers.clear();for(const timer of pending)timer.fn();await tick();}};
}
(async()=>{
 // Markup: rows type straight into inline ICD-10-CM comboboxes; no Find diagnosis button or dialog.
 let f=fixture();await f.render();await f.click('add');
 assert.match(f.host.innerHTML,/role="combobox"/);assert.match(f.host.innerHTML,/data-terminology-scope="diagnosis"/);assert.match(f.host.innerHTML,/data-terminology-system="ICD-10-CM"/);
 assert.doesNotMatch(f.host.innerHTML,/Find diagnosis|data-terminology-open|data-terminology-picker/);
 assert.equal(f.rows.length,1);assert.ok(f.rows[0].popup,'each diagnosis field carries its own suggestion list');
 console.log('PASS diagnosis rows type straight into inline code-list comboboxes with no Find diagnosis button');

 // Focus schedules a search; 2+ characters, 150 ms debounce, against the ICD-10-CM list.
 f=fixture();await f.render();await f.click('add');
 let code=f.field(0,'code');
 const focusCalls=f.calls.length;f.send('focusin',code);await f.flush();assert.ok(f.calls.length>focusCalls||/at least two characters/.test(f.rows[0].status.textContent),'focus offers the type-at-least-two-characters hint');
 code.value='E';f.send('input',code);assert.match(f.rows[0].status.textContent,/at least two characters/);
 assert.equal(f.calls.filter(c=>c.path.includes('/codes?')).length,0,'one character never searches the list');
 code.value='E1';f.send('input',code);assert.equal([...f.timers.values()].slice(-1)[0].delay,150);assert.equal(f.calls.filter(c=>c.path.includes('/codes?')).length,0,'the search waits for the debounce');
 await f.flush();
 const search=f.calls.find(c=>c.path.includes('/codes?'));
 let params=new URL(search.path,'http://fixture').searchParams;
 assert.equal(params.get('q'),'E1');assert.equal(params.get('system'),'ICD-10-CM');assert.equal(params.get('service_date'),'2026-11-07','diagnosis lookups use the encounter service date');assert.equal(params.get('billable'),'true');assert.equal(params.get('active'),'true');assert.equal(params.get('limit'),'25');
 assert.match(f.rows[0].list.innerHTML,/E11\.9/);assert.match(f.rows[0].list.innerHTML,/Type 2 diabetes/);assert.equal(code.getAttribute('aria-expanded'),'true');
 console.log('PASS typing in the code box searches ICD-10-CM after a 150 ms debounce and shows code plus description');

 // Keyboard pick fills Code and Description together and records the code-list snapshot.
 f=fixture();await f.render();await f.click('add');code=f.field(0,'code');
 code.value='E11';f.send('input',code);await f.flush();
 assert.equal(f.send('keydown',code,{key:'ArrowDown'}).prevented,true);assert.equal(code.getAttribute('aria-activedescendant'),'list-0-option-0');
 assert.equal(f.send('keydown',code,{key:'Enter'}).prevented,true);await tick();
 assert.equal(f.field(0,'code').value,dx.code);assert.equal(f.field(0,'display').value,dx.display);
 assert.equal(f.rows[0].row.dataset.catalogReleaseId,dx.release_id);assert.equal(f.rows[0].row.dataset.catalogCode,dx.code);
 assert.match(f.note().textContent,/Selected from /);assert.ok(f.calls.every(call=>call.method==='GET'),'the lookup itself never saves a record');
 console.log('PASS ArrowDown and Enter pick a code, fill Code and Description and record the code-list snapshot');

 // The description box searches by words; Escape closes and keeps typing.
 f=fixture();await f.render();await f.click('add');
 let display=f.field(0,'display');display.value='spastic hemi';f.send('input',display);await f.flush();
 params=new URL(f.calls.find(c=>c.path.includes('/codes?')).path,'http://fixture').searchParams;assert.equal(params.get('q'),'spastic hemi');
 f.send('keydown',display,{key:'ArrowUp'});assert.equal(display.getAttribute('aria-activedescendant'),'list-0-option-1');
 f.send('keydown',display,{key:'Escape'});assert.equal(f.rows[0].popup.hidden,true);assert.equal(display.value,'spastic hemi');
 console.log('PASS the description box searches by words and Escape keeps what staff typed');

 // No match stays quiet, keeps the text and never blocks.
 f=fixture();await f.render();await f.click('add');f.setResponse(path=>path.includes('/codes?')?{items:[],release:{id:dx.release_id},next_cursor:null}:{...f.data});
 let zz=f.field(0,'code');zz.value='ZZ999';f.send('input',zz);await f.flush();
 assert.match(f.rows[0].status.textContent,/No match in the code list/);assert.equal(zz.value,'ZZ999');assert.equal(f.rows[0].row.dataset.catalogReleaseId,undefined);
 f.setResponse(path=>path.includes('/codes?')?{items:[],release:null,next_cursor:null}:{...f.data});zz.value='ZZ998';f.send('input',zz);await f.flush();
 assert.match(f.rows[0].status.textContent,/No ICD-10-CM code list is installed/);assert.equal(zz.value,'ZZ998');
 console.log('PASS an unknown code shows a quiet no-match message, keeps the text and offers manual entry');

 // Leaving the field auto-picks exactly one exact code match; an ambiguous listing is never rewritten.
 f=fixture();await f.render();await f.click('add');
 let exact=f.field(0,'code');exact.value='E11.9';f.send('input',exact);await f.flush();
  f.send('focusout',exact,{relatedTarget:null});await tick();
 assert.equal(f.field(0,'display').value,dx.display);assert.equal(f.rows[0].row.dataset.catalogReleaseId,dx.release_id);
 f=fixture();await f.render();await f.click('add');
 let lower=f.field(0,'code');lower.value='g82.21';f.send('input',lower);await f.flush();
 f.send('keydown',lower,{key:'Tab'});await tick();
 assert.equal(f.field(0,'display').value,hemi.display);assert.equal(f.rows[0].row.dataset.catalogCode,hemi.code);
 f=fixture();await f.render();await f.click('add');
 let amb=f.field(0,'code');amb.value='E11';f.send('input',amb);await f.flush();
 f.send('focusout',amb,{relatedTarget:null});await tick();
 assert.equal(f.field(0,'display').value,'');assert.equal(f.rows[0].row.dataset.catalogReleaseId,undefined);
 f=fixture();await f.render();await f.click('add');
 let tabbed=f.field(0,'code');tabbed.value='E11';f.send('input',tabbed);await f.flush();
 f.send('keydown',tabbed,{key:'Tab'});await tick();
 assert.equal(f.field(0,'display').value,'','Tab with an ambiguous listing closes it and keeps the typing');
 console.log('PASS leaving the field auto-picks a single exact code match and never rewrites an ambiguous listing');

 // Generic attach helper for other screens; a null input is ignored.
 assert.equal(f.run('typeof terminologyAttachCombobox'),'function');
 f.run('terminologyAttachCombobox(null,{system:"ICD-10-CM",scope:"diagnosis"})');
 console.log('PASS terminologyAttachCombobox is generic and safe for other screens to reuse');

 // Autosave: a complete valid form saves on a short debounce with the shared version.
 f=fixture({version:3,visit:{id:'v1',version:3,status:'in_progress'},can_edit:true,diagnoses:[{id:'d1',code:'R51.9',display:'Headache',rank:1}],history:[],history_truncated:false});
 f.setResponse((path,method,body,version)=>{if(method==='GET')return {...f.data};if(path.includes('/codes?'))return {items:[dx,hemi],release:{id:dx.release_id},next_cursor:null};if(path.includes('/releases/'))return detailFor(dx.code);return {version:version+1,visit:{id:'v1',version:version+1,status:'in_progress'},can_edit:true,diagnoses:body.diagnoses,history:[],history_truncated:false};});
 await f.render();
 f.form.elements.reason.value='Added after exam';
 f.send('input',f.field(0,'display'));
 await f.flush();
 let puts=f.calls.filter(c=>c.method==='PUT');
 assert.equal(puts.length,1);assert.equal(puts[0].version,3);assert.equal(puts[0].body.reason,'Added after exam');assert.equal(puts[0].body.diagnoses[0].code,'R51.9');
 assert.equal(f.run('visitDiagnosisDrafts.size'),0);assert.equal(f.run('visitDiagnosisPending.size'),0);assert.equal(f.run('visitDiagnosisAutosave.busy'),false);
 assert.equal(f.created.some(node=>node.textContent==='Saved'),true);assert.doesNotMatch(f.host.innerHTML,/diagnosis edits that have not saved yet/);
 assert.equal((f.context.notices||[]).length,0);
 console.log('PASS a complete diagnosis row saves itself on a short debounce and the unsaved notice becomes a quiet Saved');

 // Identical typing never re-saves; a newer edit saves again with the newer version.
 // After the first save the form carries the version the server answered with, so the next
 // autosave is never refused as someone-else-changed-it.
 const firstAnswer=f.calls.find(c=>c.method==='PUT');
 assert.equal(Number(f.run("Number($('visit-diagnoses-form').dataset.version)")),firstAnswer.version+1,'the form carries the version the first save returned');
 f.form.elements.reason.value='Second reason';f.send('input',f.field(0,'display'));await f.flush();
 puts=f.calls.filter(c=>c.method==='PUT');assert.equal(puts.length,2);
 assert.equal(puts[1].version,firstAnswer.version+1,'the second save uses the version the first save returned');
 assert.equal(puts[1].body.reason,'Second reason');
 f.send('input',f.field(0,'display'));await f.flush();
 assert.equal(f.calls.filter(c=>c.method==='PUT').length,2,'the same saved values never save twice');
 console.log('PASS autosave follows the shared version forward and skips work already saved');

 // An incomplete form never triggers a save and nothing is ever blocked.
 f=fixture();await f.render();await f.click('add');
 f.form.elements.reason.value='Waiting';
 const half=f.field(0,'code');half.value='R05';f.send('input',half);await f.flush();
 assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);assert.equal(half.value,'R05');
 f.form.elements.reason.value='';f.field(0,'display').value='Cough';f.send('input',f.field(0,'display'));await f.flush();
 assert.equal(f.calls.filter(c=>c.method==='PUT').length,0,'a missing reason holds the save without blocking the form');
 console.log('PASS incomplete rows never autosave while typing stays free');

 // A conflict keeps the typing, clears pending state and offers reload; the next edit retries.
 f=fixture({version:3,visit:{id:'v1',version:3,status:'in_progress'},can_edit:true,diagnoses:[{id:'d1',code:'R51.9',display:'Headache',rank:1}],history:[],history_truncated:false});
 await f.render();let conflict=true;
 f.setResponse((path,method,body,version)=>{if(method==='GET')return {...f.data};if(path.includes('/codes?'))return {items:[dx,hemi],release:{id:dx.release_id},next_cursor:null};if(path.includes('/releases/'))return detailFor(dx.code);if(method==='PUT'&&conflict)throw new Error('Synthetic conflict');return {version:version+1,visit:{id:'v1',version:version+1,status:'in_progress'},can_edit:true,diagnoses:body.diagnoses,history:[],history_truncated:false};});
 f.form.elements.reason.value='Retry';f.send('input',f.field(0,'display'));await f.flush();
 assert.equal(f.run('visitDiagnosisPending.size'),0);assert.equal(f.run('visitDiagnosisAutosave.busy'),false);
 assert.match(f.host.innerHTML,/data-diagnosis-refresh>Reload/);
 conflict=false;f.form.elements.reason.value='Retry again';f.send('input',f.field(0,'display'));await f.flush();
 assert.equal(f.calls.filter(c=>c.method==='PUT'&&c.body.reason==='Retry again').length,1);
 console.log('PASS a conflict keeps edits, clears pending state and the next edit saves again');

 // Remove and reorder still work and never trigger a spurious save.
 f=fixture({version:3,visit:{id:'v1',version:3,status:'in_progress'},can_edit:true,diagnoses:[{id:'d1',code:'R51.9',display:'Headache',rank:1},{id:'d2',code:'R05.9',display:'Cough',rank:2}],history:[],history_truncated:false});
 await f.render();assert.equal(f.rows.length,2);
 await f.click('up',1);assert.equal(f.field(0,'code').value,'R05.9');
 await f.click('remove',1);assert.equal(f.rows.length,1);assert.equal(f.field(0,'code').value,'R05.9');
 console.log('PASS Remove and reorder keep working after the inline typeahead');
 console.log('ALL PASS diagnosis inline typeahead and autosave');
})().catch(error=>{console.error(error);process.exitCode=1;});
