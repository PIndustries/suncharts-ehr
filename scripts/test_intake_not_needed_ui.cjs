// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Staff can mark an appointment as needing no intake form, and the Home count
// leaves those appointments out of the Intake step.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const plain=value=>JSON.parse(JSON.stringify(value??null));
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function previsitFixture(role='front_desk'){
 const handlers={},calls=[],notices=[];
 const tools={innerHTML:''};
 const ctx={console,Map,Set,JSON,Array,Number,String,Object,Math,Date,Intl,URL,URLSearchParams,encodeURIComponent,structuredClone,Promise,FormData:class{},crypto:{randomUUID:()=>'synthetic-request'},
  me:{tenant_id:'tenant',user_id:'staff',role},selected:'patient-one',workspace:{},
  location:{origin:'https://ehr.example.test'},navigator:{clipboard:{writeText:async()=>{}}},
  document:{readyState:'loading',addEventListener:(type,listener)=>(handlers[type]??=[]).push(listener),getElementById:()=>null},
  esc:escape,date:value=>String(value??'').slice(0,10),human:value=>String(value).replaceAll('_',' '),notice:message=>notices.push(message),showTool(){},run:work=>ctx.pending=work(),
  $:(id,host)=>id==='tools'?tools:null,workspaceResourceAllowed:()=>true};
 ctx.api=async(path,method='GET',body,version)=>{calls.push([path,method,body,version]);return ctx.reply?ctx.reply(path,method):{};};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/previsit.js','utf8'),ctx);
 return {ctx,tools,handlers,calls,notices};
}
const click=(f,dataset)=>{const button={dataset,textContent:'',hasAttribute:name=>name in dataset,closest:()=>null};const handler=f.handlers.click.find(item=>item.toString().includes('data-previsit-not-needed'));handler({target:{closest:()=>button},preventDefault(){},stopImmediatePropagation(){}});return button;};

// Home (practice.js): the Intake step counts only appointments waiting on staff.
function practiceFixture(items){
 const nodes=new Map();
 const node=id=>{if(!nodes.has(id)){const n={id,innerHTML:'',textContent:'',dataset:{},querySelectorAll:()=>[],querySelector:()=>null,setAttribute(){},removeAttribute(){},addEventListener(){},focus(){},scrollIntoView(){}};Object.defineProperty(n,'outerHTML',{configurable:true,get(){return n.innerHTML;},set(value){n.innerHTML='';n.innerHTML=value;}});nodes.set(id,n);}return nodes.get(id);};
 const tools=node('tools');
 const ctx={console,Map,Set,JSON,Array,Number,String,Object,Math,Date,Intl,URL,URLSearchParams,encodeURIComponent,structuredClone,Promise,FormData:class{},crypto:{randomUUID:()=>'synthetic-request'},
  me:{role:'owner',user_id:'author'},selected:null,workspace:{},
  document:{readyState:'complete',addEventListener(){},getElementById:node,querySelectorAll:()=>[],querySelector:()=>null},
  esc:escape,date:value=>String(value??'').slice(0,10),human:value=>String(value).replaceAll('_',' '),notice(){},showTool(){},run:work=>ctx.pending=work(),
  $:id=>node(id),renderPracticeRows(){},renderPracticeResults(){},workspaceResourceAllowed:()=>true};
 ctx.responses={schedule:{appointments:[],blocks:[]},results:{items:[],limit:100},visits:{items:[],total:0,has_more:false},followup:{items:[]},referrals:{items:[]},claims:{items:[]},items};
 ctx.api=async path=>{const key=path.startsWith('/api/v1/schedule?')?'schedule':path.includes('/labs/inbox')?'results':path.includes('/previsit/readiness')?'previsit':path.includes('/follow-up/tasks')?'followup':path.includes('/referrals/worklist')?'referrals':path.includes('/billing/claims')?'claims':'visits';if(key==='previsit')return {items:ctx.responses.items};return ctx.responses[key];};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/practice.js','utf8'),ctx);
 return {ctx,tools};
}
const intakeCount=html=>{const nav=(html.split('<nav class="practice-journey"')[1]||'').split('</nav>')[0];const step=nav.split('</button>').find(part=>part.includes('data-practice-action="intake"'))||'';const match=step.match(/<em>(\d+)<\/em>/);return match?Number(match[1]):null;};

(async()=>{
 const appointment='00000000-0000-4000-8000-000000000001';
 // ---- Readiness table ----
 let f=previsitFixture(),c=f.ctx;
 const base={appointment_id:appointment,patient_name:'Sample, Avery',mrn:'SYN-1',starts_at:'2026-11-20T15:00:00Z'};
 // not_issued with nothing sent yet: both choices side by side.
 let html=c.previsitReadinessView([{...base,status:'not_issued'}],null);
 assert.match(html,/<div class="actions"><button type="button" data-previsit-issue="00000000-0000-4000-8000-000000000001">Issue default forms<\/button><button type="button" data-previsit-not-needed="00000000-0000-4000-8000-000000000001">No form needed<\/button><\/div>/);
 // A workflow appointment keeps only its own button.
 html=c.previsitReadinessView([{...base,status:'not_issued',workflow_instance_id:'workflow-run-1'}],null);
 assert.match(html,/>Issue workflow forms in journey</);
 assert.doesNotMatch(html,/data-previsit-issue|data-previsit-not-needed/);
 // not_needed: plain pill, plain attestation, and the Undo button alone.
 html=c.previsitReadinessView([{...base,status:'not_needed'}],null);
 assert.match(html,/<span class="pill">No form needed<\/span>/);
 assert.doesNotMatch(html,/Not needed<\/span>/,'the pill never shows the machine status');
 assert.match(html,/<td>Not needed<\/td>/);
 assert.match(html,new RegExp(`<button type="button" data-previsit-needed="${appointment}">Undo</button>`));
 assert.doesNotMatch(html,/data-previsit-issue|data-previsit-not-needed|not needed<\/span>/i,'the pill never shows the machine status');
 // Read-only staff see none of these buttons.
 const viewer=previsitFixture('read_only');
 const viewHtml=viewer.ctx.previsitReadinessView([{...base,status:'not_issued'},{...base,appointment_id:'appointment-2',status:'not_needed'}],null);
 assert.doesNotMatch(viewHtml,/data-previsit-issue|data-previsit-not-needed|data-previsit-needed|Undo/);
 assert.match(viewHtml,/Front desk, a clinician or the owner can send the intake form\./);
 assert.match(viewHtml,/Choose “No form needed” for a patient who does not need one, such as a follow-up\./);

 // ---- Clicks ----
 f=previsitFixture();c=f.ctx;
 c.reply=(path,method)=>method==='POST'?{appointment_id:appointment,status:'not_needed'}:{items:[]};
 click(f,{previsitNotNeeded:appointment});await c.pending;
 assert.deepEqual(plain(f.calls[0]),[`/api/v1/previsit/appointments/${appointment}/not-needed`,'POST',{},null]);
 assert.equal(f.notices.at(-1),'Marked as no form needed.');
 // The readiness screen redraws the same way a review redraws it.
 c.reply=path=>path==='/api/v1/previsit/settings'?{profile:null,template:null,intake_mode:'standard',standard:null}:path==='/api/v1/schedule/providers'?{items:[]}:{items:[]};
 await c.pending;
 assert.deepEqual(f.calls.map(call=>call[0]),[`/api/v1/previsit/appointments/${appointment}/not-needed`,'/api/v1/previsit/settings','/api/v1/previsit/readiness','/api/v1/schedule/providers']);
 assert.match(f.tools.innerHTML,/Pre-visit readiness/);
 f=previsitFixture();c=f.ctx;
 c.reply=(path,method)=>method==='DELETE'?{appointment_id:appointment,status:'not_issued'}:{items:[]};
 click(f,{previsitNeeded:appointment});await c.pending;
 assert.deepEqual(f.calls[0].slice(0,2),[`/api/v1/previsit/appointments/${appointment}/not-needed`,'DELETE']);
 assert.equal(f.notices.at(-1),'This appointment needs a form again.');

 // ---- Home step 1 ----
 const home=()=>vm.runInContext("$('practice-home').innerHTML",f.ctx);
 f=practiceFixture(['not_issued','sent','in_progress','submitted','reviewed','not_needed'].map((status,index)=>({appointment_id:`appointment-${index}`,status})));
 await vm.runInContext('showPracticeWorkspace().then(()=>renderPracticeWorkspace())',f.ctx);
 assert.equal(intakeCount(home()),2);
 f=practiceFixture('broken');
 await vm.runInContext('showPracticeWorkspace().then(()=>renderPracticeWorkspace())',f.ctx);
 assert.equal(intakeCount(home()),null,'unusable readiness data shows no count');
 console.log('PASS intake not-needed UI: two choices before a form is sent; plain rows and Undo for no-form-needed; Home counts only what waits on staff');
})().catch(error=>{console.error(error);process.exitCode=1;});
