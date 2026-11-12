// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(role='owner'){
 const nodes={tools:{innerHTML:''}},handlers={},listeners={},calls=[];
 const data={setting:null,credential_storage_ready:true};
 const c={Date,JSON,URL,URLSearchParams,console,setInterval:()=>0,crypto:{randomUUID:()=> 'stable-request'},me:{role},$:id=>nodes[id],esc:escape,date:x=>x,scheduleLabel:s=>String(s).replaceAll('_',' '),showTool:()=>{},notice:()=>{},document:{addEventListener:(t,cb,capture)=>{if(capture){handlers[t]=cb;(listeners[t]||=[]).push(cb);}}},FormData:class{constructor(f){return Object.entries(f.values)[Symbol.iterator]();}},run:fn=>{c.pending=fn();},api:async(...args)=>{calls.push(args);return data;}};
 vm.createContext(c);vm.runInContext(fs.readFileSync('web/connect-services.js','utf8'),c);vm.runInContext(fs.readFileSync('web/connect-onboarding.js','utf8'),c);
 return {c,nodes,handlers,listeners,calls,data,run:s=>vm.runInContext(s,c)};
}
(async()=>{
 let f=fixture();await f.run('showConnectServices()');assert.match(f.nodes.tools.innerHTML,/not active/);assert.match(f.nodes.tools.innerHTML,/Connect to SunCharts/);assert.doesNotMatch(f.nodes.tools.innerHTML,/name="installation_token"|name="installation_id"/);assert.doesNotMatch(f.nodes.tools.innerHTML,/data-connect-activate/);
 f=fixture('clinician');await f.run('showConnectServices()');assert.match(f.nodes.tools.innerHTML,/Support tickets/);assert.doesNotMatch(f.nodes.tools.innerHTML,/connect-services-form/);
 f=fixture('read_only');await f.run('showConnectServices()');assert.doesNotMatch(f.nodes.tools.innerHTML,/data-support-tickets/);
 f=fixture();f.c.api=async()=>({items:[{id:'t1',subject:'<script>bad</script>',status:'open',updated_at:'today'}]});await f.run('showSupportTickets()');assert.match(f.nodes.tools.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(f.nodes.tools.innerHTML,/<script>/);assert.match(f.nodes.tools.innerHTML,/Attach the patient, visit or claim instead/);
 let sent;f.c.api=async(...a)=>{if(a[1]==='POST'){sent=a;return {ticket:{id:'t1'}};}return {ticket:{id:'t1',subject:'Issue',status:'open'},messages:[]};};
 const form={id:'support-create-form',dataset:{request:'retry-safe'},values:{subject:'Issue',message:'Operational issue',reviewed:'on'}};f.handlers.submit({target:form,preventDefault(){},stopImmediatePropagation(){}});await f.c.pending;assert.deepEqual(JSON.parse(JSON.stringify(sent[2])),{request_id:'retry-safe',message:'Operational issue',subject:'Issue'});
 f.c.api=async()=>({ticket:{id:'t1',subject:'Closed request',status:'closed'},messages:[{message:'<img src=x>',author_kind:'support',created_at:'today'}]});await f.run('showSupportTicket("t1")');assert.doesNotMatch(f.nodes.tools.innerHTML,/support-reply-form/);assert.match(f.nodes.tools.innerHTML,/&lt;img/);
 // Server-authored roles stay distinct even when a platform reply carries provider metadata.
 f=fixture();f.c.api=async()=>({shared_support:true,ticket:{id:'partner-ticket',subject:'Partner request',status:'open',support_provider:{id:'provider-1',display_name:'Example <Support>'}},messages:[{id:'reply-1',author:'support',actor_kind:'partner',author_label:'Agent <One>',support_provider:{id:'provider-1',display_name:'Original provider'},message:'Partner reply',created_at:'today'},{id:'reply-2',author:'support',actor_kind:'platform',author_label:'SunCharts team',support_provider:{display_name:'Must not become partner'},message:'Escalated reply',created_at:'today'},{id:'reply-3',author:'installation',actor_kind:'installation',message:'Practice reply',created_at:'today'}]});await f.run('showSupportTicket("partner-ticket")');
 assert.match(f.nodes.tools.innerHTML,/Assigned partner: Example &lt;Support&gt;/);assert.match(f.nodes.tools.innerHTML,/support-role-partner">Partner<\/span><b>Agent &lt;One&gt;/);assert.match(f.nodes.tools.innerHTML,/support-role-platform">SunCharts<\/span><b>SunCharts team/);assert.match(f.nodes.tools.innerHTML,/support-role-installation">Practice/);assert.match(f.nodes.tools.innerHTML,/Your practice, this partner and SunCharts staff work in the same conversation/);assert.doesNotMatch(f.nodes.tools.innerHTML,/Agent <One>|Example <Support>|Must not become partner/);
 assert.equal(f.run('supportProviderLabel({})'),'SunCharts support');assert.equal(f.run('supportMessageAuthor({actor_kind:"partner"})'),'Partner team');assert.equal(f.run('supportMessageAuthor({actor_kind:"installation",author_label:"Untrusted label"})'),'Practice');
 assert.equal(f.run('supportMessageRole({actor_kind:"platform",support_provider:{display_name:"Partner"}})'),'platform');assert.equal(f.run('supportMessageRole({actor_kind:"installation",support_provider:{display_name:"Partner"}})'),'installation');assert.equal(f.run('supportMessageRole({author:"support"})'),'platform');assert.equal(f.run('supportMessageRole({support_provider:{display_name:"Partner"}})'),'unknown');assert.equal(f.run('supportMessageRole({actor_kind:"invented",author:"support"})'),'unknown');
 const rows=f.run('supportTicketRows({items:[{id:"ticket",subject:"Question",status:"open",support_provider:{display_name:"Provider One"}}]})');assert.match(rows,/Assigned partner: Provider One/);
 // Empty queues still explain trusted current routing; older Connect does not promise partner access.
 f=fixture();f.c.api=async()=>({shared_support:true,support_provider:{display_name:'Partner <Team>'},items:[]});await f.run('showSupportTickets()');assert.match(f.nodes.tools.innerHTML,/Sent to Partner &lt;Team&gt;/);assert.match(f.nodes.tools.innerHTML,/No support requests/);
 assert.doesNotMatch(f.run('supportRoutingSummary({support_provider:{display_name:"Partner"}})'),/same conversation/);assert.match(f.run('supportRoutingSummary({shared_support:true})'),/SunCharts staff handle/);
 f=fixture();vm.runInContext(fs.readFileSync('web/appointment-workflows.js','utf8'),f.c);await f.run('showReminderSettings()');assert.match(f.nodes.tools.innerHTML,/value="suncharts_connect" selected/);assert.match(f.nodes.tools.innerHTML,/My Resend account/);assert.match(f.nodes.tools.innerHTML,/Managed email is not active/);
 f.data.setting={version:3,delivery_mode:'own_resend',from_email:'clinic@example.test',enabled:false,verified:false};await f.run('showReminderSettings()');assert.match(f.nodes.tools.innerHTML,/value="own_resend" selected/);assert.match(f.nodes.tools.innerHTML,/clinic@example.test/);
 f=fixture();f.c.api=async()=>({status:'connected',practice_authorized:true,your_account_authorized:true,services:{configured:true,enabled:true,verified:true,fresh:true,availability:'available',last_checked_at:'today',last_verified_at:'today'}});f.nodes['shell-connect-status']={setAttribute(k,v){this[k]=v;}};f.nodes['shell-connect-label']={textContent:''};await f.run('refreshConnectionBadge()');assert.match(f.nodes['shell-connect-label'].textContent,/Connected/);assert.equal(f.nodes['shell-connect-status']['data-state'],'connected');const summary=f.run('connectStatusCard(connectionStatusSnapshot)');assert.match(summary,/Your account is authorized/);assert.match(summary,/Last verified today/);assert.match(f.run("connectStatusCard({status:'not_connected',services:{configured:true,enabled:false,verified:false,revoked:true,fresh:true,availability:'available',reminders_available:true,support_available:true}})"),/Managed email: Unavailable · Support: Unavailable/);
 const staleCard={outerHTML:''};f.c.document.querySelectorAll=()=>[staleCard];f.c.api=async()=>{throw Error('offline');};await f.run('refreshConnectionBadge()');assert.match(f.nodes['shell-connect-label'].textContent,/Status unavailable/);assert.equal(f.nodes['shell-connect-status']['data-state'],'unknown');assert.match(staleCard.outerHTML,/Status unavailable/);
 assert.throws(()=>f.run("connectAuthorizationDestination('https://evil.example/connect/ehr?request=x')"));assert.throws(()=>f.run("connectAuthorizationDestination('https://connect.suncharts.app/signin?request=x')"));assert.equal(f.run("connectAuthorizationDestination('https://connect.suncharts.app/connect/ehr?request=safe')"),'https://connect.suncharts.app/connect/ehr?request=safe');
 assert.throws(()=>f.run("connectAuthorizationDestination('https://my.suncharts.app/connect/ehr?request=safe')"),'new attempts must not silently switch to the legacy origin');assert.equal(f.run("connectAuthorizationDestination('https://my.suncharts.app/connect/ehr?request=safe','https://my.suncharts.app')"),'https://my.suncharts.app/connect/ehr?request=safe');
 assert.equal(f.run("connectAuthorizationDestination('https://dev.suncharts.app/connect/ehr?request=safe','https://dev.suncharts.app')"),'https://dev.suncharts.app/connect/ehr?request=safe');
 assert.doesNotMatch(f.run("connectStatusCard({origin:'https://my.suncharts.app',status:'connected',services:{}})"),/Local synthetic/);

 assert.throws(()=>f.run("connectAuthorizationDestination('https://evil.example/connect/ehr?request=x','https://evil.example')"));assert.equal(f.run("connectAuthorizationDestination('http://127.0.0.1:8080/connect/ehr?request=safe','http://127.0.0.1:8080')"),'http://127.0.0.1:8080/connect/ehr?request=safe');
 const connected=f.run("connectOnboardingCard({pending:{status:'completed'}},{status:'connected'})");assert.match(connected,/<h3>SunCharts connection set up/);assert.doesNotMatch(connected,/Continue connection/);
 const unavailable=f.run('connectOnboardingCard({available:false})');assert.match(unavailable,/not ready to connect/);assert.match(unavailable,/data-connect-start disabled/);
 // Returning to the app must finish only after an authenticated same-origin POST,
 // and must not advertise Connected when the live service check is unavailable.
 f=fixture();let route='?connect_onboarding=11111111-1111-4111-8111-111111111111',completed=false,noticeText='';
 f.c.location={search:route,pathname:'/',hash:''};f.c.history={replaceState(_a,_b,value){route=value;}};f.c.showApps=async()=>{};f.c.notice=text=>{noticeText=text;};f.c.refreshConnectionBadge=async()=>({status:'authorized'});
 f.c.api=async(path,method,body,version)=>{if(method==='POST'){assert.equal(version,7);completed=true;return {pending:{status:'completed'}};}return {pending:{id:'11111111-1111-4111-8111-111111111111',status:'callback_received',version:7}};};
 assert.equal(await f.run('finishConnectOnboarding()'),true);assert.equal(completed,true);assert.equal(route,'/');assert.match(noticeText,/Authorization completed/);assert.doesNotMatch(noticeText,/^Connected/);
 f.c.location.search='?connect_onboarding=11111111-1111-4111-8111-111111111111';completed=false;f.c.api=async()=>({pending:{id:'22222222-2222-4222-8222-222222222222',status:'callback_received',version:1}});await f.run('finishConnectOnboarding()');assert.equal(completed,false);assert.match(noticeText,/another session/);
 // Live health updates follow the current session and close on logout.
 f=fixture();const streams=[];f.c.EventSource=class{constructor(url){this.url=url;this.events={};streams.push(this);}addEventListener(type,cb){this.events[type]=cb;}close(){this.closed=true;}};
 f.nodes['shell-connect-status']={setAttribute(k,v){this[k]=v;}};f.nodes['shell-connect-label']={textContent:''};
 f.c.api=async()=>({status:'not_connected',services:{}});await f.run('refreshConnectionBadge()');assert.equal(streams.length,1);assert.equal(streams[0].url,'/api/v1/connect/status/events');
 streams[0].events.connection({data:JSON.stringify({status:'connected',practice_authorized:true,transport:{configured:true,state:'connected',last_seen_at:'now'},services:{}})});assert.equal(f.nodes['shell-connect-label'].textContent,'SunCharts: Connected');
 streams[0].events.connection({data:JSON.stringify({status:'reconnecting',transport:{configured:true,state:'reconnecting'},services:{}})});assert.equal(f.nodes['shell-connect-label'].textContent,'SunCharts: Reconnecting');
 streams[0].events.connection({data:'not json'});assert.equal(f.nodes['shell-connect-label'].textContent,'SunCharts: Reconnecting');
 let resolve;f.c.api=()=>new Promise(r=>{resolve=r;});const pending=f.run('refreshConnectionBadge()');streams[0].events.connection({data:JSON.stringify({status:'offline',services:{}})});resolve({status:'connected',services:{}});await pending;assert.equal(f.nodes['shell-connect-label'].textContent,'SunCharts: Offline','late HTTP response cannot overwrite a newer stream event');
 f.run('clearConnectionStatusSession()');assert.equal(streams[0].closed,true);streams[0].events.connection({data:JSON.stringify({status:'connected'})});assert.equal(f.nodes['shell-connect-label'].textContent,'SunCharts: Offline');
 await f.run('startConnectionStatusEvents(me)');assert.equal(streams.length,2);f.c.me={role:'owner'};streams[1].events.connection({data:JSON.stringify({status:'connected'})});assert.equal(f.nodes['shell-connect-label'].textContent,'SunCharts: Offline','old session cannot restore connection status');
 // Support requests carry what the person is working on: auto-attached records, removable chips, searched records and files.
 {
  const P='11111111-1111-4111-8111-111111111111',V='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',P2='44444444-4444-4444-8444-444444444444',F1='55555555-5555-4555-8555-555555555555';
  const attrs=map=>{const dataset={};for(const [k,v] of Object.entries(map))dataset[k.replace(/^data-/,'').replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=v;return dataset;};
  const setup=(role='front_desk')=>{
   const f=fixture(role);let n=0;f.c.crypto.randomUUID=()=>`00000000-0000-4000-8000-${String(++n).padStart(12,'0')}`;
   f.host={dataset:{supportExtras:'new'},innerHTML:'',querySelector:()=>null};f.nodes['support-create-extras']=f.host;f.nodes['clinical-workspace']={hidden:false};
   f.notices=[];f.c.notice=(text,error)=>f.notices.push([text,!!error]);f.c.location={hash:''};
   f.c.selected=P;f.c.workspace={patient:{family_name:'Synthetic',given_name:'Avery',mrn:'SYN-1'}};f.c.chartSection='visits';f.c.activeVisit={id:V};f.c.encounterDateLabel=()=>'Nov 1, 2026';
   f.c.document.querySelector=()=>null;
   f.c.run=fn=>{f.c.pending=Promise.resolve().then(fn).catch(error=>{f.notices.push([error.message,true]);});};
   f.form=values=>({id:'support-create-form',dataset:{request:'10000000-0000-4000-8000-000000000001'},values,querySelector:()=>f.host,closest:()=>null});
   f.button=(map,host=f.host,form)=>({dataset:attrs(map),hasAttribute:name=>name in map,closest:selector=>selector==='[data-support-extras]'?host:selector==='form'?form:null});
   f.dispatch=button=>{let stopped=false;for(const listener of f.listeners.click){if(stopped)break;listener({target:{closest:()=>button},preventDefault(){},stopImmediatePropagation(){stopped=true;}});}};f.click=async(map,form)=>{f.dispatch(f.button(map,f.host,form));await f.c.pending;};
   f.submit=async form=>{f.handlers.submit({target:form,preventDefault(){},stopImmediatePropagation(){}});await f.c.pending;};
   f.c.api=async(...a)=>{f.calls.push(a);if(a[1]==='POST')return {ticket:{id:'t1'}};if(a[0].endsWith('/tickets'))return {items:[]};return {ticket:{id:'t1',subject:'Issue',status:'open'},messages:[]};};
   return f;
  };
  const file=(name,type,size)=>({name,type,size});
  // Opening support from an encounter attaches the patient and the visit; an open claim comes along too.
  let f=setup();f.c.document.querySelector=selector=>selector==='[data-support-claim]'?{dataset:{supportClaim:C,supportClaimLabel:'SC0001',supportPatient:P,supportPatientLabel:'ignored'},closest:()=>null}:null;
  await f.run('openSupportFromHere()');
  assert.match(f.nodes.tools.innerHTML,/Attach the patient, visit or claim instead/);assert.match(f.nodes.tools.innerHTML,/data-support-extras="new"/);
  assert.match(f.nodes.tools.innerHTML,/Patient · Synthetic, Avery · MRN SYN-1/);assert.match(f.nodes.tools.innerHTML,/Visit Nov 1, 2026/);assert.match(f.nodes.tools.innerHTML,/Claim SC0001/);
  assert.match(f.nodes.tools.innerHTML,/Add patient, visit or claim/);assert.match(f.nodes.tools.innerHTML,/Add files/);assert.doesNotMatch(f.nodes.tools.innerHTML,/review-ack|name="reviewed"/,'the confirmation box stays removed');
  assert.deepEqual(JSON.parse(JSON.stringify(f.run("supportExtrasFor('new').links.map(l=>[l.kind,l.id,l.auto])"))),[['patient',P,true],['visit',V,true],['claim',C,true]]);
  // Only what is on screen is attached: a chart left open behind another screen is not.
  f=setup();f.nodes['clinical-workspace'].hidden=true;await f.run('openSupportFromHere()');assert.equal(f.run("supportExtrasFor('new').links.length"),0);assert.match(f.nodes.tools.innerHTML,/No patient, visit or claim attached/);
  // A claim opened from the claims list brings its patient.
  f.c.document.querySelector=()=>({dataset:{supportClaim:C,supportClaimLabel:'SC0001',supportPatient:P,supportPatientLabel:'Synthetic, Avery · MRN SYN-1'},closest:()=>null});
  assert.deepEqual(JSON.parse(JSON.stringify(f.run('supportCurrentContext().map(l=>l.kind+":"+l.label)'))),['patient:Synthetic, Avery · MRN SYN-1','claim:Claim SC0001']);
  // Chips are removable, and what was removed is not sent. Records the person added by hand survive a new context.
  f=setup();await f.run('openSupportFromHere()');await f.click({'data-support-link-remove':'0'});
  assert.doesNotMatch(f.host.innerHTML,/Patient ·/);assert.match(f.host.innerHTML,/Visit Nov 1, 2026/);
  f.run(`supportAddLink(supportExtrasFor('new'),{kind:'patient',id:'${P2}',label:'Example, Blake · MRN SYN-2'})`);
  let form=f.form({subject:'Issue',message:'Please look at this visit'});await f.submit(form);
  let sent=f.calls.find(a=>a[1]==='POST');assert.deepEqual(JSON.parse(JSON.stringify(sent[2])),{request_id:'10000000-0000-4000-8000-000000000001',message:'Please look at this visit',subject:'Issue',links:[{kind:'visit',id:V},{kind:'patient',id:P2}]},'only kind and id are sent; the server writes the label');
  assert.equal(f.run("supportExtras.has('new')"),false,'sent attachments do not stay on the next message');
  f=setup();f.run(`supportAddLink(supportExtrasFor('new'),{kind:'patient',id:'${P2}',label:'Example, Blake · MRN SYN-2'})`);await f.run('openSupportFromHere()');f.c.selected=undefined;f.c.document.querySelector=()=>({dataset:{supportClaim:C,supportClaimLabel:'SC0001'},closest:()=>null});await f.run('openSupportFromHere()');
  assert.deepEqual(JSON.parse(JSON.stringify(f.run("supportExtrasFor('new').links.map(l=>l.kind+':'+l.id)"))),['patient:'+P2,'claim:'+C],'a new context replaces the earlier automatic chips only');
  for(let i=0;i<12;i++)f.run(`supportAddLink(supportExtrasFor('new'),{kind:'visit',id:'66666666-6666-4666-8666-${String(i).padStart(12,'0')}',label:'Visit'})`);
  assert.equal(f.run("supportExtrasFor('new').links.length"),10);assert.equal(f.run("supportExtrasFor('new').problem"),'Up to 10 patients, visits or claims per message.');
  // Search, then optionally add one of that patient's visits or claims.
  f=setup();f.nodes['clinical-workspace'].hidden=true;
  f.c.api=async(...a)=>{f.calls.push(a);if(a[0]==='/api/v1/patients')return {items:[{id:P,given_name:'Avery',family_name:'Synthetic',mrn:'SYN-1',birth_date:'1990-01-01'},{id:P2,given_name:'Blake',family_name:'<Example>',mrn:'SYN-2',birth_date:'1985-02-03'}],next_cursor:null};if(a[0].endsWith('/workspace'))return {visits:[{id:V,appointment_id:'a1',status:'signed'}],appointments:[{id:'a1',starts_at:'2026-11-01'}]};if(a[0].startsWith('/api/v1/billing/claims?patient_id='))return {items:[{id:C,control_number:'SC0001',status:'submitted'}]};return {items:[]};};
  await f.click({'data-support-link-add':''});assert.match(f.host.innerHTML,/Find a patient/);assert.match(f.host.innerHTML,/Type at least 2 letters/);
  const results={innerHTML:''};f.handlers.input({target:{value:'syn-2',hasAttribute:name=>name==='data-support-search',closest:()=>({dataset:{supportExtras:'new'},querySelector:()=>results})}});
  assert.match(results.innerHTML,/&lt;Example&gt;, Blake/);assert.doesNotMatch(results.innerHTML,/Avery|<Example>/);
  f.handlers.input({target:{value:'avery',hasAttribute:name=>name==='data-support-search',closest:()=>({dataset:{supportExtras:'new'},querySelector:()=>results})}});assert.match(results.innerHTML,new RegExp(`data-support-pick-patient="${P}"`));
  await f.click({'data-support-pick-patient':P});assert.match(f.host.innerHTML,/Patient · Synthetic, Avery · MRN SYN-1/);assert.match(f.host.innerHTML,/Visit 2026-11-01/);assert.match(f.host.innerHTML,/Claim SC0001/);assert.match(f.host.innerHTML,/Attach visit/);
  await f.click({'data-support-pick':'claim:'+C});assert.deepEqual(JSON.parse(JSON.stringify(f.run("supportExtrasFor('new').links.map(l=>l.kind)"))),['patient','claim']);
  await f.click({'data-support-picker-close':''});assert.doesNotMatch(f.host.innerHTML,/Find a patient|support-picker/);
  // Pasting a screenshot into the message adds it as a file; pasted text stays text.
  f=setup();form=f.form({subject:'Issue',message:'See screenshot'});let prevented=0;
  f.handlers.paste({target:{closest:()=>form},clipboardData:{getData:()=>'',files:[file('image.png','image/png',2048)]},preventDefault(){prevented++;}});
  assert.equal(prevented,1);assert.match(f.host.innerHTML,/Pasted image 1\.png<small>2 KB/);assert.match(f.host.innerHTML,/data-support-file-remove="0"/);
  f.handlers.paste({target:{closest:()=>form},clipboardData:{getData:()=>'copied cells',files:[file('image.png','image/png',2048)]},preventDefault(){prevented++;}});
  f.handlers.paste({target:{closest:()=>form},clipboardData:{getData:()=>'',files:[],items:[{kind:'string'},{kind:'file',getAsFile:()=>file('','image/jpeg',900)}]},preventDefault(){prevented++;}});
  assert.equal(prevented,2);assert.deepEqual(JSON.parse(JSON.stringify(f.run("supportExtrasFor('new').files.map(x=>x.name)"))),['Pasted image 1.png','Pasted image 2.jpg']);
  // Size, type and count limits use the plain messages.
  f.run("supportAddFiles('new',[{name:'big.pdf',type:'application/pdf',size:10*1024*1024+1}])");assert.match(f.host.innerHTML,/That file is larger than 10 MB\./);
  f.run("supportAddFiles('new',[{name:'tool.exe',type:'application/octet-stream',size:10}])");assert.match(f.host.innerHTML,/That type of file can&#39;t be attached\. Use an image, PDF, text or CSV file\./);
  f.run("supportAddFiles('new',[{name:'empty.txt',type:'text/plain',size:0}])");assert.match(f.host.innerHTML,/That file is empty\./);
  f.run("supportAddFiles('new',[{name:'export.csv',type:'',size:10},{name:'exact.pdf',type:'application/pdf',size:10*1024*1024}])");assert.equal(f.run("supportExtrasFor('new').files.length"),4);assert.equal(f.run("supportExtrasFor('new').files[2].type"),'text/csv');assert.doesNotMatch(f.host.innerHTML,/data-support-problem/);
  f.run("supportAddFiles('new',[{name:'a.png',type:'image/png',size:1},{name:'b.png',type:'image/png',size:1}])");assert.equal(f.run("supportExtrasFor('new').files.length"),5);assert.match(f.host.innerHTML,/Up to 5 files per message\./);
  f.handlers.change({target:{files:[file('c.png','image/png',1)],value:'x',hasAttribute:name=>name==='data-support-file-input',closest:()=>f.host}});assert.equal(f.run("supportExtrasFor('new').files.length"),5);
  await f.click({'data-support-file-remove':'4'});assert.equal(f.run("supportExtrasFor('new').files.length"),4);assert.equal(f.run('supportHasDrafts()'),true,'added files count as unsent work');
  f.handlers.drop({target:{closest:()=>form},dataTransfer:{types:['Files'],files:[file('dropped.txt','text/plain',12)]},preventDefault(){prevented++;}});assert.equal(f.run("supportExtrasFor('new').files[4].name"),'dropped.txt');
  // A failed upload keeps the message and the files; sending again repeats the same upload and request IDs.
  f=setup();f.nodes['clinical-workspace'].hidden=true;f.c.me={role:'front_desk',tenant_id:'tenant',user_id:'user'};form=f.form({subject:'Issue',message:'Typed message'});
  f.run("supportAddFiles('new',[{name:'scan 1.png',type:'image/png',size:5},{name:'notes.txt',type:'text/plain',size:7}])");
  const uploads=[];let failSecond=true;
  f.c.fetch=async(url,options)=>{uploads.push([url,options]);if(url.includes('000000000002')&&failSecond)throw new Error('offline');return {ok:true,status:200,json:async()=>({id:url.includes('000000000001')?F1:'77777777-7777-4777-8777-777777777777',filename:'x',content_type:'image/png',size:5})};};
  await f.submit(form);assert.equal(f.calls.filter(a=>a[1]==='POST').length,0,'the message is not sent without its files');assert.match(f.notices.at(-1)[0],/notes\.txt could not be uploaded\. Your message is still here/);
  assert.equal(form.values.message,'Typed message');assert.match(f.host.innerHTML,/notes\.txt<small>7 bytes · Not sent yet/);assert.equal(f.run("supportExtrasFor('new').files.length"),2);
  assert.equal(uploads[0][0],'/api/v1/connect/services/support-files?request_id=00000000-0000-4000-8000-000000000001');assert.equal(uploads[0][1].method,'POST');assert.equal(uploads[0][1].headers['Content-Type'],'image/png');assert.equal(uploads[0][1].headers['X-Filename'],'scan%201.png');assert.equal(uploads[0][1].headers['X-SunCharts-Staff-Context'],'tenant:user');assert.equal(uploads[0][1].body.name,'scan 1.png');
  failSecond=false;await f.submit(form);assert.equal(uploads.length,3,'the stored file is not uploaded twice');assert.equal(uploads[2][0],uploads[1][0],'the retry reuses the file request ID');
  sent=f.calls.find(a=>a[1]==='POST');assert.deepEqual(JSON.parse(JSON.stringify(sent[2])),{request_id:'10000000-0000-4000-8000-000000000001',message:'Typed message',subject:'Issue',attachments:[F1,'77777777-7777-4777-8777-777777777777']});
  // A refused upload shows the server's plain reason.
  f=setup();f.nodes['clinical-workspace'].hidden=true;form=f.form({subject:'Issue',message:'Typed'});f.run("supportAddFiles('new',[{name:'a.png',type:'image/png',size:5}])");
  f.c.fetch=async()=>({ok:false,status:413,json:async()=>({})});await f.submit(form);assert.equal(f.notices.at(-1)[0],'That file is larger than 10 MB.');
  f.c.fetch=async()=>({ok:false,status:400,json:async()=>({message:"That type of file can't be attached."})});await f.submit(form);assert.equal(f.notices.at(-1)[0],"That type of file can't be attached.");
  // An unchanged retry repeats one request; an edited message becomes a new one.
  f=setup();f.nodes['clinical-workspace'].hidden=true;form=f.form({subject:'Issue',message:'First'});let failing=true;const posts=[];
  f.c.api=async(...a)=>{if(a[1]==='POST'){posts.push(a[2]);if(failing){const error=new Error('SunCharts service is unavailable');error.status=400;throw error;}return {ticket:{id:'t1'}};}return {ticket:{id:'t1',subject:'Issue',status:'open'},messages:[]};};
  await f.submit(form);await f.submit(form);assert.equal(posts[1].request_id,posts[0].request_id);form.values.message='Edited';failing=false;await f.submit(form);assert.notEqual(posts[2].request_id,posts[0].request_id);assert.equal(posts[2].message,'Edited');
  // An earlier SunCharts service refuses links and files: the message can still go without them.
  f=setup();await f.run('openSupportFromHere()');form=f.form({subject:'Issue',message:'Still needs sending'});const tried=[];
  f.c.api=async(...a)=>{if(a[1]==='POST'){tried.push(JSON.parse(JSON.stringify(a[2])));if(a[2].links||a[2].attachments){const error=new Error('Support cannot receive attached records or files yet.');error.status=409;error.code='support_attachments_unavailable';throw error;}return {ticket:{id:'t1'}};}return {ticket:{id:'t1',subject:'Issue',status:'open'},messages:[]};};
  await f.submit(form);assert.equal(tried.length,1);assert.match(f.host.innerHTML,/Support cannot receive attached patients, visits, claims or files yet\. Your message has not been sent\./);assert.match(f.host.innerHTML,/data-support-send-plain>Send without attachments</);assert.equal(form.values.message,'Still needs sending');
  form.reportValidity=()=>true;await f.click({'data-support-send-plain':''},form);
  assert.equal(tried.length,2);assert.deepEqual(Object.keys(tried[1]).sort(),['message','request_id','subject']);assert.notEqual(tried[1].request_id,tried[0].request_id,'the refused request ID is not reused for different content');assert.equal(f.notices.at(-1)[0],'Support request recorded.');
  // Conversation: links open the record in the EHR; files come through this EHR, never straight from another site.
  f=setup();f.c.api=async()=>({ticket:{id:'t1',subject:'Issue',status:'open'},messages:[{id:'m1',actor_kind:'installation',message:'See attached',created_at:'today',links:[{kind:'patient',id:P,label:'MRN SYN-1'},{kind:'visit',id:V,label:'Visit 2026-11-01 · MRN SYN-1'},{kind:'claim',id:C,label:'Claim <SC1> · MRN SYN-1'},{kind:'chart',id:P,label:'Dropped'},{kind:'claim',id:'not-an-id',label:'Dropped'}],attachments:[{id:F1,filename:'scan "1".png',content_type:'image/png',size:2048},{id:'77777777-7777-4777-8777-777777777777',filename:'report.pdf',content_type:'application/pdf',size:3145728},{id:'javascript:alert(1)',filename:'bad',content_type:'image/png',size:1}]},{id:'m2',actor_kind:'platform',message:'Thanks',created_at:'today',links:[],attachments:[]}]});
  await f.run('showSupportTicket("t1")');const thread=f.nodes.tools.innerHTML;
  assert.match(thread,new RegExp(`data-support-link-open="patient:${P}"[^>]*>Patient · MRN SYN-1<`));assert.match(thread,new RegExp(`data-support-link-open="visit:${V}"[^>]*>Visit 2026-11-01 · MRN SYN-1<`));assert.match(thread,/Claim &lt;SC1&gt; · MRN SYN-1/);assert.doesNotMatch(thread,/Dropped|javascript:|<SC1>/);
  assert.match(thread,new RegExp(`<a class="support-file support-file-image" href="/api/v1/connect/services/support-files/${F1}" target="_blank" rel="noopener noreferrer"[^>]*><img src="/api/v1/connect/services/support-files/${F1}" alt="scan &quot;1&quot;.png"`));
  assert.match(thread,/href="\/api\/v1\/connect\/services\/support-files\/77777777-7777-4777-8777-777777777777" download="report\.pdf">.*report\.pdf<small>3\.0 MB · Download/);assert.equal((thread.match(/support-message-extras/g)||[]).length,1,'messages without links or files stay as they were');
  assert.match(thread,/data-support-extras="t1"/);
  f.run(`supportOpenLink('patient','${P}')`);assert.equal(f.c.location.hash,`#/patients/${P}/overview`);f.run(`supportOpenLink('claim','${C}')`);assert.equal(f.c.location.hash,`#/claims/${C}`);
  f.c.api=async path=>{assert.equal(path,'/api/v1/visits/'+V);return {id:V,patient_id:P};};f.run(`supportOpenLink('visit','${V}')`);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.c.location.hash,`#/patients/${P}/encounter/${V}`);
  f.c.location.hash='';f.run("supportOpenLink('patient','../../x')");assert.equal(f.c.location.hash,'');
  f.dispatch(f.button({'data-support-link-open':'claim:'+C}));assert.equal(f.c.location.hash,`#/claims/${C}`);
  // A reply joins an existing conversation, so the open chart is offered and attached only when chosen.
  f=setup();f.nodes['support-reply-extras']={dataset:{supportExtras:'t1'},innerHTML:'',querySelector:()=>null};f.host=f.nodes['support-reply-extras'];f.run("supportSuggestContext('t1')");await f.run('showSupportTicket("t1")');
  assert.match(f.nodes.tools.innerHTML,/data-support-link-suggested="0">Attach Patient · Synthetic, Avery · MRN SYN-1</);assert.equal(f.run("supportExtrasFor('t1').links.length"),0);
  await f.click({'data-support-link-suggested':'0'});assert.match(f.host.innerHTML,/<span class="pill support-chip">Patient · Synthetic, Avery · MRN SYN-1/);assert.doesNotMatch(f.host.innerHTML,/data-support-link-suggested="0"/);
  const reply={id:'support-reply-form',dataset:{request:'10000000-0000-4000-8000-000000000009',ticket:'t1'},values:{message:'More detail'},querySelector:()=>f.host,closest:()=>null};await f.submit(reply);
  sent=f.calls.find(a=>a[1]==='POST');assert.equal(sent[0],'/api/v1/connect/services/tickets/t1/replies');assert.deepEqual(JSON.parse(JSON.stringify(sent[2])),{request_id:'10000000-0000-4000-8000-000000000009',message:'More detail',links:[{kind:'patient',id:P}]});
  // The quiet entry point appears only for staff who can use support, and opens a request with the context attached.
  f=setup();assert.equal(f.run("supportHelpButton('patient')"),'<button type="button" class="quiet support-help" data-support-help >Get help with this patient</button>');
  f.c.connectionStatusSnapshot=undefined;f.run("connectionStatusSnapshot={services:{support_available:false}}");assert.equal(f.run("supportHelpButton('claim')"),'');
  assert.equal(setup('read_only').run("supportHelpButton('visit')"),'');
  f=setup();f.nodes['support-create-form']={id:'support-create-form',dataset:{request:'r'},values:{},scrollIntoView(){this.scrolled=true;},elements:{subject:{focus(){this.focused=true;}}}};
  f.dispatch(f.button({'data-support-help':''},null));await f.c.pending;
  assert.match(f.nodes.tools.innerHTML,/Patient · Synthetic, Avery · MRN SYN-1/);assert.equal(f.nodes['support-create-form'].scrolled,true);assert.equal(f.nodes['support-create-form'].elements.subject.focused,true);
  // Staff-facing wording only.
  f.run("supportAddFiles('new',[{name:'a.png',type:'image/png',size:1}]);supportExtrasFor('new').unavailable=true;supportExtrasFor('new').picker={query:'',patients:[],cursor:'x',patient:null,visits:[],claims:[]}");
  const copy=f.run("supportExtrasBody('new')").replace(/<[^>]+>/g,' ');assert.doesNotMatch(copy,/—|native|opaque|idempotent|payload|evidence|proxy|request ID/i);
  for(const source of ['web/connect-services.js','web/connect-updates.js'])assert.doesNotMatch(fs.readFileSync(source,'utf8').split('\n').filter(line=>/support-(extras|about|file|picker|help)|Support cannot|could not be uploaded|Get help with/.test(line)&&!line.trim().startsWith('//')).join('\n').replace(/\/\/.*$/gm,''),/—/);
 }
 console.log('PASS Connect UI: inactive state, owner configuration, staff support access, escaped messages, reviewed opaque-id requests, closed conversations, attached records and files');
})().catch(e=>{console.error(e);process.exitCode=1;});
