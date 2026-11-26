// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const source=fs.readFileSync('web/visit-diagnoses.js','utf8');
function fixture(){
 let html='',form=null;const handlers={},timers=new Map(),badge={textContent:''};let timerId=0;
 const data={version:3,visit:{id:'v1',version:3,status:'in_progress'},can_edit:true,diagnoses:[{id:'d1',code:'R51.9',display:'<script>Headache</script>',rank:1}],history:[{visit_version:3,actor_label:'Synthetic clinician',created_at:'2026-10-26',reason:'Initial assessment',snapshot:[{code:'R51.9',display:'Headache'}]}]};
 const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');
 const host={textContent:'',querySelector:sel=>sel==='[data-diagnosis-rebase]'||sel==='[data-diagnosis-unsaved]'?null:sel==='.section-head .badge'?badge:null,get innerHTML(){return html;},set innerHTML(value){html=value;const match=value.match(/<form id="visit-diagnoses-form" data-visit-id="([^"]+)" data-patient-id="([^"]+)" data-version="([^"]+)"/);form=match?{id:'visit-diagnoses-form',dataset:{visitId:decode(match[1]),patientId:decode(match[2]),version:match[3]},rows:[],elements:{},closest:()=>host,querySelectorAll(){return this.rows.map(row=>({querySelector(selector){const name=selector.includes('code')?'code':'display';return {name,get value(){return row[name]},set value(value){row[name]=value}};}}));}}:null;
  if(form){const start=value.indexOf('<form id="visit-diagnoses-form"'),end=value.indexOf('</form>');const segment=end<0?'':value.slice(start,end);for(const cell of segment.split('data-diagnosis-row').slice(1)){const code=cell.match(/name="code"[^>]*?value="([^"]*)"/),display=cell.match(/name="display"[^>]*?value="([^"]*)"/);if(code&&display)form.rows.push({code:decode(code[1]),display:decode(display[1])});}form.elements.reason={value:decode(segment.match(/name="reason" value="([^"]*)"/)[1])};}}};
 const context=vm.createContext({console,Map,selected:'p1',me:{user_id:'c1',role:'clinician'},activeVisit:{id:'v1',version:3,status:'in_progress'},window:{confirm:()=>true},confirmAction:async()=>true,workspace:{patient_id:'p1'},$:(id)=>id==='visit-diagnoses'?host:id==='visit-diagnoses-form'?form:null,api:async()=>data,date:s=>s,esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'),setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),document:{addEventListener:(name,fn)=>{(handlers[name]??=[]).push(fn);},createElement:()=>({dataset:{},className:'',textContent:'',setAttribute(){},remove(){}})},run:fn=>{context.pending=fn();},captureVisitDrafts:()=>{},rememberVisit:v=>{context.activeVisit=v;},refreshEncounterProgress:()=>{},notice:m=>{context.notices=[...(context.notices||[]),m];}});
 vm.runInContext(source,context);
 return {context,host,handlers,data,timers,runTimer(){const pending=[...timers.values()];timers.clear();pending.forEach(t=>t.fn());},get form(){return form;},run:code=>vm.runInContext(code,context),submit(){for(const handler of handlers.submit)handler({target:form,preventDefault(){},stopImmediatePropagation(){}});return context.pending;},click(name,value=''){const attribute='data-diagnosis-'+name,key='diagnosis'+name[0].toUpperCase()+name.slice(1),button={dataset:{[key]:String(value)},hasAttribute:n=>n===attribute,closest:()=>null};for(const handler of handlers.click)handler({target:{closest:()=>button},preventDefault(){},stopImmediatePropagation(){}});return context.pending;}};
}
(async()=>{
 let f=fixture();await f.run('renderVisitDiagnoses()');assert.match(f.host.innerHTML,/&lt;script&gt;Headache/);assert.doesNotMatch(f.host.innerHTML,/<script>/);assert.match(f.host.innerHTML,/Primary diagnosis/);assert.match(f.host.innerHTML,/Synthetic clinician/);assert.match(f.host.innerHTML,/Initial assessment/);assert.match(f.host.innerHTML,/<li>R51.9 · Headache/);console.log('PASS diagnosis codes, escaped descriptions and attributed revision snapshots render');
 f=fixture();f.data.diagnoses=[];await f.run('renderVisitDiagnoses()');
 assert.equal(f.form.rows.length,1);assert.match(f.host.innerHTML,/Primary diagnosis/);
 assert.equal(f.form.rows[0].code,'');assert.equal(f.timers.size,0);
 f.run('captureVisitDiagnosisDraft()');assert.equal(f.run('visitDiagnosisDrafts.size'),0);
 const emptyWrites=[];f.context.api=async(...args)=>{emptyWrites.push(args);return f.data;};
 await f.submit();assert.equal(emptyWrites.length,0,'a pristine placeholder never sends an empty diagnosis update');
 await f.click('add');assert.equal(f.form.rows.length,2);assert.match(f.host.innerHTML,/Diagnosis 2/);
 f.form.rows[0]={code:'R05.9',display:''};f.form.elements.reason.value='Clinical review';
 assert.equal(f.run("visitDiagnosisReady($('visit-diagnoses-form'))"),false,'a started row still needs its diagnosis description');
 f.form.rows[0].display='Cough';assert.equal(f.run("visitDiagnosisReady($('visit-diagnoses-form'))"),true,'a second untouched row does not block the first diagnosis');
 assert.deepEqual(JSON.parse(f.run("JSON.stringify(visitDiagnosisFormValues($('visit-diagnoses-form')).diagnoses)")),[{code:'R05.9',display:'Cough'}]);
 f=fixture();f.data.diagnoses=[];await f.run('renderVisitDiagnoses()');await f.click('add');
 assert.equal(f.run("visitDiagnosisAppendRow({code:'R05.9',display:'Cough'})"),true);
 assert.equal(f.form.rows.length,1,'a suggestion occupies the blank primary row');
 assert.equal(f.form.rows[0].code,'R05.9');
 f=fixture();await f.run('renderVisitDiagnoses()');await f.click('remove',0);
 assert.equal(f.form.rows.length,1);assert.equal(f.form.rows[0].code,'');assert.match(f.host.innerHTML,/Primary diagnosis/);
 f.form.elements.reason.value='Correction';let deletion;
 f.context.api=async(path,method,body)=>{deletion=body;return {...f.data,diagnoses:[],version:4,visit:{...f.data.visit,version:4}};};
 await f.submit();assert.deepEqual(JSON.parse(JSON.stringify(deletion.diagnoses)),[],'removing the last saved diagnosis clears it on the server');
 assert.equal(f.form.rows.length,1);assert.equal(f.form.rows[0].code,'');assert.equal(f.run('visitDiagnosisDrafts.size'),0);
 f=fixture();f.data.diagnoses=[];f.data.can_edit=false;await f.run('renderVisitDiagnoses()');assert.equal(f.form,null);
 assert.doesNotMatch(f.host.innerHTML,/data-diagnosis-row|Primary diagnosis|Add diagnosis/);
 console.log('PASS blank primary ICD row, optional empty rows, partial validation, suggested codes, final removal, and read-only visits');
 f=fixture();f.data.can_edit=false;await f.run('renderVisitDiagnoses()');assert.equal(f.form,null);assert.doesNotMatch(f.host.innerHTML,/Save diagnoses|Add diagnosis/);console.log('PASS unassigned and read-only staff see saved diagnoses without mutation controls');
 f=fixture();await f.run('renderVisitDiagnoses()');f.run('captureVisitDiagnosisDraft()');assert.equal(f.run('visitDiagnosisDrafts.size'),0);await f.click('add');assert.equal(f.form.rows.length,2);f.form.rows[1]={code:'R05.9',display:'Cough'};await f.click('up',1);assert.equal(f.form.rows[0].code,'R05.9');await f.click('remove',1);assert.equal(f.form.rows.length,1);assert.equal(f.form.rows[0].code,'R05.9');console.log('PASS adding, primary reorder and removal preserve editable diagnosis order');
 f=fixture();await f.run('renderVisitDiagnoses()');f.form.rows[0].display='Unsaved headache';f.form.elements.reason.value='Clinical review';f.run('captureVisitDiagnosisDraft()');f.data.version=4;f.data.visit.version=4;f.context.activeVisit.version=4;await f.run('renderVisitDiagnoses()');assert.match(f.host.innerHTML,/Unsaved headache/);assert.match(f.host.innerHTML,/Keep my changes/);assert.match(f.host.innerHTML,/<button type="submit" disabled>Save diagnoses/);await f.click('rebase',4);assert.equal(f.form.dataset.version,'4');assert.doesNotMatch(f.host.innerHTML,/Keep my changes/);console.log('PASS encounter version changes preserve edits and require explicit comparison');
 f=fixture();f.run("visitDiagnosisDrafts.set('v1',{patientId:'p-other',version:3,values:{diagnoses:[{code:'R00.0',display:'FOREIGN DRAFT'}],reason:'foreign'}})");await f.run('renderVisitDiagnoses()');assert.doesNotMatch(f.host.innerHTML,/FOREIGN DRAFT/);console.log('PASS diagnosis drafts remain isolated to their patient');
 f=fixture();let finish;f.context.api=()=>new Promise(resolve=>finish=resolve);const waiting=f.run('renderVisitDiagnoses()');f.context.selected='p2';f.context.activeVisit={id:'v2',version:1};f.host.innerHTML='Other chart';finish(f.data);await waiting;assert.equal(f.host.innerHTML,'Other chart');assert.equal(f.run('visitDiagnosisStates.size'),0);console.log('PASS stale asynchronous reads cannot replace another patient chart');
 f=fixture();f.context.activeVisit.version=2;await f.run('renderVisitDiagnoses()');assert.match(f.host.innerHTML,/Reload it before editing/);assert.equal(f.form,null);assert.equal(f.run('visitDiagnosisProgress().complete'),false);console.log('PASS stale encounter context blocks editing and does not mark diagnoses complete');
 f=fixture();await f.run('renderVisitDiagnoses()');f.form.rows[0].display='Updated finding';f.form.elements.reason.dataset={optionalNote:'1'};
 assert.equal(f.run("visitDiagnosisFormValues($('visit-diagnoses-form')).reason"),'Updated encounter diagnoses');
 assert.equal(f.run("visitDiagnosisReady($('visit-diagnoses-form'))"),true,'optional reason never leaves a completed diagnosis waiting for an invisible input');
 f.form.elements.reason.dataset={};assert.equal(f.run("visitDiagnosisReady($('visit-diagnoses-form'))"),false);
 f=fixture();await f.run('renderVisitDiagnoses()');f.form.rows[0].display='Changed description';f.form.elements.reason.value='Updated assessment';let request;const response={...f.data,diagnoses:[{code:'R51.9',display:'Changed description'}],version:4,visit:{id:'v1',version:4,status:'in_progress'}};f.context.api=async(path,method,body,version)=>{request={path,method,body,version};return response;};await f.submit();assert.equal(request.method,'PUT');assert.equal(request.version,3);assert.equal(request.body.reason,'Updated assessment');assert.equal(request.body.diagnoses[0].display,'Changed description');assert.equal(f.run('visitDiagnosisDrafts.size'),0);f.run('captureVisitDiagnosisDraft()');assert.equal(f.run('visitDiagnosisDrafts.size'),0);assert.equal(f.run('visitDiagnosisProgress().label'),'1 recorded');console.log('PASS saves send ordered rows, reason and shared version without false dirty state');
 f=fixture();await f.run('renderVisitDiagnoses()');f.form.rows[0].display='Submitted';f.form.elements.reason.value='Update';let finishSave;const saved={...f.data,diagnoses:[{code:'R51.9',display:'Submitted'}],version:4,visit:{id:'v1',version:4,status:'in_progress'}};f.context.api=()=>new Promise(resolve=>finishSave=resolve);const saving=f.submit();f.form.rows[0].display='Newer typing';f.run('captureVisitDiagnosisDraft()');finishSave(saved);await saving;assert.equal(f.run("visitDiagnosisDrafts.get('v1').values.diagnoses[0].display"),'Newer typing');assert.equal(f.run("visitDiagnosisDrafts.get('v1').version"),4);assert.match(f.host.innerHTML,/Newer typing/);assert.doesNotMatch(f.host.innerHTML,/Keep my changes/);console.log('PASS newer typing survives a save against its own resulting version');
 // Closing while a save is in flight includes the newer edit, using the version returned by our first write.
 f=fixture();await f.run('renderVisitDiagnoses()');
 const initialForm=f.form,submitted=[];
 f.form.elements.reason.dataset={optionalNote:'1'};f.form.rows[0].display='First version';
 f.context.api=async(path,method,body,version)=>{
  submitted.push({display:body.diagnoses[0].display,version});
  if(submitted.length===1)await new Promise(resolve=>finishSave=resolve);
  return {...f.data,version:version+1,visit:{...f.data.visit,version:version+1},diagnoses:body.diagnoses};
 };
 const write=f.run("submitVisitDiagnoses($('visit-diagnoses-form'),{autosave:true})");
 f.form.rows[0].display='Latest typing';f.run('captureVisitDiagnosisDraft()');
 const flush=f.run("flushVisitCodeDiagnoses($('visit-diagnoses-form'))");
 finishSave();await Promise.all([write,flush]);
 assert.deepEqual(submitted,[{display:'First version',version:3},{display:'Latest typing',version:4}]);
 assert.equal(f.form,initialForm,'a successful autosave preserves the field being edited');
 assert.equal(f.form.dataset.version,'5');assert.equal(f.run('visitDiagnosisDrafts.size'),0);
 console.log('PASS closing the coding dialog flushes in-flight edits in order without a false conflict');
 // The server trims and uppercases ICD and may replace the description from its code list.
 f=fixture();await f.run('renderVisitDiagnoses()');
 f.form.rows[0]={code:' r51.9 ',display:' Entered description '};f.form.elements.reason.dataset={optionalNote:'1'};
 let canonicalWrites=0;
 f.context.api=async(path,method,body,version)=>{
  assert.equal(++canonicalWrites,1,'closing should never resubmit a row already normalized by the server');
  return {...f.data,version:4,visit:{...f.data.visit,version:4},diagnoses:[{code:'R51.9',display:'Official description'}]};
 };
 await f.run("flushVisitCodeDiagnoses($('visit-diagnoses-form'))");await f.run("flushVisitCodeDiagnoses($('visit-diagnoses-form'))");
 assert.deepEqual(f.form.rows[0],{code:'R51.9',display:'Official description'});assert.equal(canonicalWrites,1);
 console.log('PASS normalized ICD and official description reach the fields without another save');
 // Persistent failures wait for an explicit recovery. A stale version requires comparison; partial rows stay editable.
 f=fixture();await f.run('renderVisitDiagnoses()');
 let attempts=0;f.form.elements.reason.dataset={optionalNote:'1'};f.form.rows[0].display='Changed';
 f.context.api=async()=>{attempts++;throw Object.assign(new Error('Stale version'),{status:409});};
 await assert.rejects(f.run("flushVisitCodeDiagnoses($('visit-diagnoses-form'))"),/Reload diagnoses/);
 f.run("queueVisitDiagnosisAutosave($('visit-diagnoses-form'))");f.runTimer();
 await assert.rejects(f.run("flushVisitCodeDiagnoses($('visit-diagnoses-form'))"),/Reload diagnoses/);
 assert.equal(attempts,1);assert.equal(f.timers.size,0);assert.equal(f.form.rows[0].display,'Changed');
 f=fixture();await f.run('renderVisitDiagnoses()');f.form.rows[0].display='';
 await assert.rejects(f.run("flushVisitCodeDiagnoses($('visit-diagnoses-form'))"),/code and description/);
 console.log('PASS a version conflict halts repeat writes and incomplete rows keep the dialog open');
 f=fixture();await f.run('renderVisitDiagnoses()');f.form.rows[0].display='Retry this';f.form.elements.reason.value='Retry';f.context.api=async()=>{throw new Error('Synthetic conflict');};await assert.rejects(f.submit(),/Synthetic conflict/);assert.equal(f.run("visitDiagnosisDrafts.get('v1').values.diagnoses[0].display"),'Retry this');assert.equal(f.run('visitDiagnosisPending.size'),0);assert.match(f.host.innerHTML,/data-diagnosis-refresh>Reload/);console.log('PASS failed or conflicting saves retain edits and expose explicit reload');
 f=fixture();f.data.visit.status='signed';f.context.activeVisit.status='signed';f.data.can_edit=false;await f.run('renderVisitDiagnoses()');assert.equal(f.form,null);assert.match(f.host.innerHTML,/Only a clinician or the practice owner can change/);assert.doesNotMatch(f.host.innerHTML,/Save diagnoses|Add diagnosis|read-only|Changes after signing/);assert.match(f.host.innerHTML,/can change the diagnoses of a signed visit/);console.log('PASS a signed visit shows its saved diagnoses to staff without billing rights, with no edit controls');
 f=fixture();f.data.visit.status='signed';f.context.activeVisit.status='signed';f.run("visitDiagnosisDrafts.set('v1',{patientId:'p1',version:2,values:{diagnoses:[{code:'R00.0',display:'UNSIGNED DRAFT'},],reason:'draft'}})");await f.run('renderVisitDiagnoses()');assert.match(f.host.innerHTML,/Changes after signing are saved as billing corrections/);assert.equal(f.form.rows[0].code,'R00.0');assert.match(f.host.innerHTML,/name="code" value="R00.0"/);assert.equal(f.run('visitDiagnosisDrafts.size'),1);await f.click('discard');assert.equal(f.run('visitDiagnosisDrafts.size'),0);assert.doesNotMatch(f.host.innerHTML,/Discard unsaved diagnoses/);assert.match(f.host.innerHTML,/&lt;script&gt;Headache/);console.log('PASS a signed visit stays editable, keeps a pre-signing draft apart, and discards it explicitly');
 f=fixture();f.data.visit.status='signed';f.context.activeVisit.status='signed';await f.run('renderVisitDiagnoses()');assert.equal(f.timers.size,0,'opening signed diagnoses does not schedule a correction');assert.match(f.host.innerHTML,/Changes after signing are saved as billing corrections/);assert.doesNotMatch(f.host.innerHTML,/they are not in the signed record|Discard unsaved diagnoses|Unsigned diagnosis draft/);f.form.rows[0].display='Corrected headache';f.form.elements.reason.value='Billing correction';let signedRequest;const signedSaved={...f.data,diagnoses:[{code:'R51.9',display:'Corrected headache'}],version:4,visit:{id:'v1',version:4,status:'signed'}};f.context.api=async(path,method,body,version)=>{signedRequest={path,method,body,version};return signedSaved;};await f.submit();assert.equal(signedRequest.method,'PUT');assert.equal(signedRequest.version,3);assert.equal(signedRequest.body.reason,'Billing correction');assert.equal(signedRequest.body.diagnoses[0].display,'Corrected headache');assert.equal(f.run('visitDiagnosisDrafts.size'),0);assert.equal(f.form.rows[0].display,'Corrected headache');f.run('captureVisitDiagnosisDraft()');assert.equal(f.run('visitDiagnosisDrafts.size'),0);console.log('PASS a signed visit saves corrected rows with a reason through the same autosave path');
 f=fixture();await f.run('renderVisitDiagnoses()');f.form.elements.reason.value='Session test';let lateResponse;f.context.api=()=>new Promise(resolve=>lateResponse=resolve);const oldSave=f.submit();f.context.me={user_id:'c1'};f.run('visitDiagnosisDrafts.clear();visitDiagnosisStates.clear()');lateResponse({...f.data,version:4,visit:{id:'v1',version:4,status:'in_progress'}});await oldSave;assert.equal(f.run('visitDiagnosisStates.size'),0);assert.equal(f.run('visitDiagnosisDrafts.size'),0);console.log('PASS a prior session save cannot repopulate diagnosis state after reauthentication');
 f=fixture();f.data.history_truncated=true;await f.run('renderVisitDiagnoses()');assert.match(f.host.innerHTML,/Older changes are not shown/);console.log('PASS bounded history clearly discloses omitted older revisions');
 f=fixture();await f.run('renderVisitDiagnoses()');assert.equal(f.run("visitDiagnosisAppendRow({code:'E11.9',display:'Type 2 diabetes',catalog_release_id:'rel1'})"),true);assert.equal(f.form.rows.length,2);assert.equal(f.form.rows[1].code,'E11.9');assert.equal(f.run("visitDiagnosisDrafts.get('v1').values.diagnoses[1].catalog_release_id"),'rel1');assert.match(f.host.innerHTML,/data-catalog-release-id="rel1"/);assert.equal(f.run("visitDiagnosisAppendRow({code:'E11.9',display:'Again'})"),false);assert.equal(f.form.elements.reason.value,'Added from the note suggestions');console.log('PASS a code added from outside the type-ahead joins the draft once, in order, with its catalog release');
 const app=fs.readFileSync('web/app.js','utf8'),workspace=fs.readFileSync('web/specialty-workspace.js','utf8');assert.match(app,/await visitNoteFlush\(\{signing:true\}\)/);assert.match(fs.readFileSync('web/visit-note.js','utf8'),/Review the diagnosis edits before signing/);assert.match(app,/visitDiagnosisDrafts.clear\(\);visitDiagnosisStates.clear\(\);visitDiagnosisPending.clear\(\);visitDiagnosisGeneration\+\+/);assert.match(app,/beforeunload[\s\S]*visitDiagnosisDrafts.size/);assert.match(workspace,/chartTabLabels=\{[^}]*clinical:'Clinical lists'/);console.log('PASS application integrates signing guard, logout cleanup, unload warning and configurable chart navigation');
})().catch(error=>{console.error(error);process.exitCode=1;});
