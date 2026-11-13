// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic data only.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/data-import.js','utf8'),billing=fs.readFileSync('web/billing.js','utf8'),clinical=fs.readFileSync('web/clinical.js','utf8'),app=fs.readFileSync('web/app.js','utf8');
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const plain=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const visible=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
const internalTerms=/reconcile digest|source identifier|source_id|staged|idempotent|tenant|snapshot|manifest|base64|session|token|source instance|job-1|—/i;
const chart=(id,given,family,birth,mrn,match,extra={})=>({patient_id:id,given_name:given,family_name:family,birth_date:birth,mrn,match,archived:false,...extra});
function job(overrides={}){
 return {id:'job-1',source_instance:'synthetic-emr',status:'reconciled',digest:'digest-1',manifest:{source_revision:'Synthetic export 1',expected_counts:{patient:4,medical_problem:1,medication:0},limitations:[]},
  report:{errors:[],ready_to_import:false,patients_needing_decision:1,patients:[
   {source_id:'1001',given_name:'Avery Q',family_name:'Synthetic',birth_date:'1990-01-01',status:'match',candidates:[chart('c1','Avery','Synthetic','1990-01-01','SYN-001','exact')],decision:{action:'attach',patient_id:'c1',preselected:true}},
   {source_id:'2002',given_name:'Blake',family_name:'<b>Example</b>',birth_date:'1985-12-31',status:'possible',candidates:[chart('c2','Blake','Example','1985-12-31','SYN-002','exact'),chart('c3','Blair','Example','1985-12-31','SYN-003','similar',{archived:true})],decision:null},
   {source_id:'3003',given_name:'Casey',family_name:'Unmatched',birth_date:'1970-07-07',status:'new',candidates:[],decision:null},
   {source_id:'4004',given_name:'Drew',family_name:'Earlier',birth_date:'1960-06-06',status:'linked',candidates:[],decision:null,chart:chart('c4','Drew','Earlier','1960-06-06','SYN-004')}]},...overrides};
}
function fixture(jobs){
 const listeners={},calls=[],notices=[],confirms=[];let html='';
 const tools={get innerHTML(){return html;},set innerHTML(v){html=v;}},slots={};
 const c=vm.createContext({console,esc,date:v=>v,me:{role:'owner'},selected:'p1',activeVisit:null,workspace:null,TextEncoder,btoa,crypto:require('node:crypto').webcrypto,
  $:id=>id==='tools'?tools:id.startsWith('import-files-status-')?(slots[id]??={innerHTML:''}):null,showTool(){},notice:(message,error=false)=>notices.push([message,error]),run:fn=>fn(),
  confirmAction:async(message,options)=>{confirms.push([message,options]);return true;},
  api:async(path,method='GET',body)=>{calls.push([path,method,plain(body)]);if(path==='/api/v1/migrations'&&method==='GET')return {items:jobs()};return {};},
  document:{addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn)}});
 vm.runInContext(source,c);
 const button=(dataset,attributes=[])=>({dataset,hasAttribute:name=>attributes.includes(name),closest(selector){return selector==='button'?this:null;}});
 return {c,calls,notices,confirms,slots,get html(){return html;},run:code=>vm.runInContext(code,c),click:async target=>{await Promise.all(listeners.click.map(fn=>fn({target})));await new Promise(resolve=>setImmediate(resolve));},button};
}
(async()=>{
 let current=job(),f=fixture(()=>[current]);await f.run('showMigrations()');
 let text=visible(f.html);
 // The patient from the file sits beside the chart the clinic already has, with name, birth date and MRN.
 assert.match(f.html,/<li class="import-decision " data-import-patient="1001">.*?In the import file<\/small><b>Avery Q Synthetic<\/b><span>Born 1990-01-01<\/span>.*?Chart you already have<\/small><b>Avery Synthetic<\/b><span>Born 1990-01-01 · MRN SYN-001<\/span>/s);
 assert.match(f.html,/aria-pressed="true" data-import-job="job-1" data-import-source="1001" data-import-attach="c1" >Attach to this chart<\/button>/,'a single exact match is pre-selected but still shown');
 assert.match(f.html,/aria-pressed="false" data-import-job="job-1" data-import-source="1001" data-import-create >Create a new chart<\/button>/);
 assert.match(text,/Records will go on the chart you chose\./);
 // A weaker or repeated match has no choice made yet.
 assert.match(f.html,/<li class="import-decision undecided" data-import-patient="2002">/);
 assert.match(f.html,/Possible match<\/small><b>Blair Example<\/b><span>Born 1985-12-31 · MRN SYN-003 · Archived<\/span>/);
 assert.equal((f.html.match(/data-import-source="2002"[^>]*>Attach to this chart/g)||[]).length,2);
 assert.match(text,/Choose one to continue\./);
 assert.match(text,/1 new chart · 1 matches a chart you already have · 1 possible match · 1 already imported/);
 assert.match(text,/1 patient needs a choice before you can import\./);
 assert.match(f.html,/data-commit="job-1" data-digest="digest-1" disabled>Import records<\/button>/,'importing waits for every choice');
 assert.ok(!f.html.includes('data-import-patient="3003"')&&!f.html.includes('data-import-patient="4004"'),'new and already imported patients need no choice');
 assert.match(f.html,/Blake &lt;b&gt;Example&lt;\/b&gt;/);
 assert.doesNotMatch(text,internalTerms);
 assert.doesNotMatch(f.html,/type="checkbox"|name="reason"/,'no confirmation boxes or reason fields');
 assert.match(text,/4 patients · 1 problem/);
 console.log('PASS decision list shows the imported patient beside each existing chart with both choices');

 await f.click(f.button({importJob:'job-1',importSource:'2002',importAttach:'c2'}));
 assert.deepEqual(f.calls.at(-2),['/api/v1/migrations/job-1/patient-decisions','POST',{source_id:'2002',action:'attach',patient_id:'c2'}]);
 assert.deepEqual(f.calls.at(-1).slice(0,2),['/api/v1/migrations','GET'],'the list reloads after a choice');
 await f.click(f.button({importJob:'job-1',importSource:'1001'},['data-import-create']));
 assert.deepEqual(f.calls.at(-2),['/api/v1/migrations/job-1/patient-decisions','POST',{source_id:'1001',action:'create'}]);
 const before=f.calls.length;await f.click(f.button({reconcile:'job-1'}));await f.click(f.button({}));
 assert.equal(f.calls.length,before,'other buttons are left to the shared handler');
 console.log('PASS attach and create buttons record the choice for that patient');

 current=job();current.report.patients[1].decision={action:'attach',patient_id:'c2'};current.report.patients[0].decision={action:'create'};current.report.ready_to_import=true;current.report.patients_needing_decision=0;
 await f.run('showMigrations()');
 assert.match(f.html,/data-commit="job-1" data-digest="digest-1" >Import records<\/button>/);
 assert.match(f.html,/aria-pressed="true" data-import-job="job-1" data-import-source="2002" data-import-attach="c2" >/);
 assert.match(f.html,/aria-pressed="true" data-import-job="job-1" data-import-source="1001" data-import-create >/);
 assert.doesNotMatch(visible(f.html),/before you can import/);
 await f.run('importCommit({dataset:{commit:"job-1",digest:"digest-1"}})');
 assert.equal(f.confirms[0][0],'1 patient goes onto charts you already have. 2 new charts are created. This cannot be undone.');
 assert.equal(f.confirms[0][1].confirmLabel,'Import records');
 assert.deepEqual(f.calls.find(call=>call[0].endsWith('/commit')),['/api/v1/migrations/job-1/commit','POST',{digest:'digest-1'}]);
 assert.deepEqual(f.notices.at(-1),['Records imported.',false]);
 f.c.confirmAction=async()=>false;const committed=f.calls.filter(call=>call[0].endsWith('/commit')).length;await f.run('importCommit({dataset:{commit:"job-1",digest:"digest-1"}})');
 assert.equal(f.calls.filter(call=>call[0].endsWith('/commit')).length,committed,'declining the dialog imports nothing');
 console.log('PASS import is offered once every patient has a choice and states what will happen');

 current=job({status:'imported'});await f.run('showMigrations()');
 assert.doesNotMatch(f.html,/data-commit=/);
 assert.equal((f.html.match(/<button[^>]*data-import-(attach|create)/g)||[]).length,0,'no choice buttons remain after import');assert.match(f.html,/Added to this chart|New chart created/,'the finished choice is shown as text');
 current=job({status:'collecting'});current.report.errors=[{kind:'patient',error:'source_count_mismatch'},{kind:'form',error:'something_new'}];await f.run('showMigrations()');
 text=visible(f.html);assert.match(text,/The file is incomplete\. Upload it again\./);assert.match(text,/This file has a problem\. Upload a fresh copy\./);assert.doesNotMatch(text,/source_count_mismatch|something_new/);
 assert.match(f.html,/data-reconcile="job-1">Check again<\/button>/);assert.doesNotMatch(text,internalTerms);
 f.run('importNotice({errors:[],patients_needing_decision:2})');assert.deepEqual(f.notices.at(-1),['File checked. 2 patients need your choice before importing.',false]);
 console.log('PASS imported and unusable files are explained in plain words');

 // Files from the previous system: the owner picks the prepared folder and each file goes to its chart.
 const sha=raw=>require('node:crypto').createHash('sha256').update(raw).digest('hex');
 const blob=(name,raw)=>{const bytes=Buffer.from(raw);let reads=0;return {name,size:bytes.length,get reads(){return reads;},text:async()=>bytes.toString('utf8'),arrayBuffer:async()=>{reads+=1;return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length);}};};
 const pdf=n=>`%PDF-1.4 synthetic ${n}\n%%EOF\n`;
 const entry=(n,patient,extra={})=>{const raw=pdf(n),digest=sha(raw);return {file:`${digest}.pdf`,source_patient_id:patient,original_name:`Synthetic letter ${n}.pdf`,upload_name:`Synthetic letter ${n}.pdf`,content_type:'application/pdf',category:'correspondence',size:Buffer.byteLength(raw),sha256:digest,request_id:`00000000-0000-4000-8000-00000000000${n}`,title:`Synthetic letter ${n}`,notes:'Imported from the previous record system.',...extra};};
 const entries=[entry(1,'1001'),entry(2,'1001'),entry(3,'2002'),entry(4,'9999')];
 const folder=(list,instance='synthetic-emr')=>[blob('.DS_Store','x'),blob('files-manifest.json',JSON.stringify({format:'suncharts-import-files/1',source_instance:instance,files:list})),...[1,2,3,4].map(n=>blob(`${sha(pdf(n))}.pdf`,pdf(n)))];
 current=job({status:'imported'});f=fixture(()=>[current]);await f.run('showMigrations()');text=visible(f.html);
 assert.match(text,/Add files from the previous system/);assert.match(text,/Choose the files folder prepared for this import\./);
 assert.match(f.html,/<input type="file" webkitdirectory multiple data-import-files-input>/);assert.match(f.html,/<input type="file" multiple data-import-files-input>/,'a plain multi-file choice is offered as well');
 assert.match(f.html,/data-import-files-add="job-1" >Add files<\/button>/);assert.doesNotMatch(text,internalTerms);assert.doesNotMatch(f.html,/type="checkbox"/);
 current=job();await f.run('showMigrations()');assert.doesNotMatch(f.html,/import-files/,'files are offered only once the import is done');
 current=job({status:'imported'});await f.run('showMigrations()');
 const status=()=>f.slots['import-files-status-job-1'].innerHTML,posts=()=>f.calls.filter(c=>c[1]==='POST'&&c[0].endsWith('/documents'));
 const progress=[];let failing=new Set(['00000000-0000-4000-8000-000000000002']),replayed=new Set();
 f.c.api=async(path,method='GET',body)=>{
  f.calls.push([path,method,plain(body)]);
  if(path==='/api/v1/migrations')return {items:[current]};
  if(path==='/api/v1/migrations/job-1/patient-links')return {job_id:'job-1',source_instance:'synthetic-emr',items:[{source_patient_id:'1001',patient_id:'chart-a'},{source_patient_id:'2002',patient_id:'chart-b'}]};
  if(path.endsWith('/documents')){progress.push(visible(status()));if(failing.has(body.request_id))throw Object.assign(new Error('Unable to complete this action. Please check your entries.'),{status:400});if(replayed.has(body.request_id))throw Object.assign(new Error('request identity already used for another document'),{status:409});return {id:'doc'};}
  return {};};
 const chosen=folder(entries);
 await f.run('importFilesChoose')(current,chosen);
 assert.deepEqual(f.calls.filter(c=>c[0].endsWith('/patient-links')).map(c=>c.slice(0,2)),[['/api/v1/migrations/job-1/patient-links','GET']]);
 assert.deepEqual(posts().map(c=>c[0]),['/api/v1/patients/chart-a/documents','/api/v1/patients/chart-a/documents','/api/v1/patients/chart-b/documents'],'each file goes to the chart its patient was imported to');
 assert.deepEqual(posts()[0][2],{request_id:'00000000-0000-4000-8000-000000000001',filename:'Synthetic letter 1.pdf',content_type:'application/pdf',content_base64:Buffer.from(pdf(1)).toString('base64'),reason:'Imported from the previous record system',
  content:{title:'Synthetic letter 1',category:'correspondence',document_date:null,visit_id:null,notes:'Imported from the previous record system.',status:'active'}},'the same request the command-line upload sends');
 assert.match(progress[0],/0 of 4 uploaded.*Keep this page open/);assert.match(progress[2],/1 of 4 uploaded · 1 could not be added so far/);
 assert.deepEqual(chosen.slice(2).map(file=>file.reads),[1,1,1,0],'a file is read only when its turn comes');
 text=visible(status());
 assert.match(text,/2 of 4 uploaded\. 2 files could not be added\./);assert.match(text,/Synthetic letter 2\.pdf: The chart did not accept this file\./);assert.match(text,/Synthetic letter 4\.pdf: This patient has no chart from this import\./);
 assert.match(status(),/data-import-files-retry="job-1">Try the failed ones again<\/button>/);assert.doesNotMatch(text,internalTerms);
 assert.deepEqual(f.notices.at(-1),['2 of 4 files uploaded. 2 could not be added.',true]);
 await f.run('showMigrations()');assert.match(f.html,/Try the failed ones again/,'the result is still shown when the page is opened again');
 console.log('PASS files from the prepared folder go to the right charts one at a time with progress');

 failing=new Set();let before2=posts().length;
 await f.click(f.button({importFilesRetry:'job-1'}));await new Promise(resolve=>setTimeout(resolve,20));
 assert.deepEqual(posts().slice(before2).map(c=>c[2].request_id),['00000000-0000-4000-8000-000000000002'],'only the failed files are tried again');
 assert.match(visible(status()),/3 of 4 uploaded\. 1 file could not be added\./);
 // Choosing the folder again: files already on the chart count as done, nothing is added twice.
 replayed=new Set(['00000000-0000-4000-8000-000000000001']);before2=posts().length;
 await f.run('importFilesChoose')(current,folder(entries.slice(0,3)));
 assert.equal(posts().length-before2,3);assert.match(visible(status()),/3 of 3 uploaded\. The files are on each patient's chart, under Files\./);assert.doesNotMatch(status(),/retry/);
 assert.deepEqual(f.notices.at(-1),['3 of 3 files uploaded.',false]);
 // The Add files button reads both inputs of its own card.
 before2=posts().length;const inputs=[{files:[]},{files:folder(entries.slice(0,1))}];
 await f.click({...f.button({importFilesAdd:'job-1'}),closest(selector){return selector==='button'?this:{querySelectorAll:()=>inputs};}});await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(posts().length-before2,1);assert.match(visible(status()),/1 of 1 uploaded\./);
 console.log('PASS failed files can be tried again and a second run adds nothing twice');

 before2=posts().length;
 await f.run('importFilesChoose')(current,folder(entries,'another-emr'));
 assert.match(visible(status()),/This files folder was prepared for a different import\. Choose the folder prepared for this import\./);
 await f.run('importFilesChoose')(current,[blob('letter.pdf',pdf(1))]);
 assert.match(visible(status()),/This is not the files folder prepared for this import\./);
 await f.run('importFilesChoose')(current,[]);assert.match(visible(status()),/Choose the files folder first\./);
 await f.run('importFilesChoose')(current,folder([{...entries[0],file:'../Avery Synthetic.pdf'}]));assert.match(visible(status()),/This files folder is damaged\./);
 await f.run('importFilesChoose')(current,[blob('files-manifest.json','not json')]);assert.match(visible(status()),/This files folder is damaged\./);
 assert.equal(posts().length,before2,'nothing is uploaded from a folder that does not belong to this import');
 // A swapped or cut-off file is caught before it is sent; a lost sign-in stops the run.
 const cut=folder(entries.slice(0,2));cut[2]=blob(cut[2].name,pdf(9).slice(0,cut[2].size));cut.splice(3,1);
 await f.run('importFilesChoose')(current,cut);
 assert.match(visible(status()),/Synthetic letter 1\.pdf: This file is damaged\..*Synthetic letter 2\.pdf: This file was not in the folder you chose\./);assert.equal(posts().length,before2);
 f.c.api=async(path,method='GET',body)=>{f.calls.push([path,method,plain(body)]);if(path.endsWith('/patient-links'))return {items:[{source_patient_id:'1001',patient_id:'chart-a'}]};throw new Error('Please sign in to continue.');};
 await f.run('importFilesChoose')(current,folder(entries.slice(0,2)));
 assert.equal(posts().length-before2,1,'no more files are sent after sign-in is lost');assert.match(visible(status()),/0 of 2 uploaded\. 2 files could not be added\..*You were signed out\. Sign in and try again\./);
 assert.doesNotMatch(visible(status()),internalTerms);
 assert.match(app,/button\.dataset\.importFilesAdd\|\|button\.dataset\.importFilesRetry\)return;/);
 console.log('PASS a folder for another import, a damaged folder and a lost sign-in are refused in plain words');

 // Contact details from the previous system: "Use this" only where the chart has nothing.
 const contact={phone:'+1-555-0100',email:'synthetic.patient@example.test',language:'Spanish',administrative_gender:'female',address:{line1:'1 Synthetic Way',city:'Testville',region:'TX',postal_code:'75000',country:'US'}};
 f=fixture(()=>[]);f.c.workspace={history:[{id:'h1',kind:'form',source_data:{contact}}],demographics:{version:1,content:{phone:'555-0000',language:'Spanish'}},clinical:{items:[]}};
 let block=f.run('importedContactBlock()');text=visible(block);
 assert.match(block,/<h3>From previous system<\/h3>/);
 assert.deepEqual([...block.matchAll(/data-use-contact="([a-z_]+)" data-record="h1">Use this<\/button>/g)].map(m=>m[1]),['email','address','administrative_gender']);
 assert.match(text,/Phone \+1-555-0100 Chart has 555-0000/);assert.match(text,/Language Spanish Same as the chart/);
 assert.match(text,/1 Synthetic Way, Testville, TX, 75000, US/);assert.doesNotMatch(text,internalTerms);
 f.c.me={role:'nurse'};assert.doesNotMatch(f.run('importedContactBlock()'),/Use this/);f.c.me={role:'front_desk'};
 f.c.api=async(path,method,body)=>{f.calls.push([path,method,plain(body)]);return {version:2,content:{phone:'555-0000',language:'Spanish',email:contact.email}};};
 await f.click(f.button({useContact:'email',record:'h1'}));
 assert.deepEqual(f.calls.at(-1),['/api/v1/patients/p1/history/h1/use-contact','POST',{field:'email'}]);
 assert.equal(f.c.workspace.demographics.version,2);assert.deepEqual(f.notices.at(-1),['Email added to the chart.',false]);
 assert.doesNotMatch(f.run('importedContactBlock()'),/data-use-contact="email"/);
 f.c.workspace.demographics={version:1,content:contact};assert.equal(f.run('importedContactBlock()'),'','a chart the import filled shows no second copy');
 f.c.workspace.history=[{id:'h2',kind:'encounter',source_data:{}}];assert.equal(f.run('importedContactBlock()'),'');
 console.log('PASS previous-system contact details fill only empty chart fields');

 // Reconcile all: the imported list is shown first; entries already on the chart are left out.
 f=fixture(()=>[]);f.c.me={role:'clinician'};
 f.c.workspace={history:[{id:'h1',kind:'medical_problem',data:{title:'Synthetic spasticity',codes:'ICD-10-CM G80.1',onset:'2020-03-04',status:'active'}},{id:'h2',kind:'medical_problem',data:{title:'synthetic  migraine'.replace('  ',' ')}},{id:'h3',kind:'medical_problem',data:{title:'Synthetic asthma'}},{id:'h4',kind:'medication',data:{title:'Synthetic relaxant',started:'2023-02-01'}}],
  clinical:{items:[{id:'e1',kind:'problem',content:{title:'Synthetic Migraine'},source_history_id:null},{id:'e2',kind:'problem',content:{title:'Reconciled earlier'},source_history_id:'h3'}]}};
 block=f.run('importedListBlock("problem")');text=visible(block);
 assert.match(text,/From previous system \(2\)/);assert.match(text,/Synthetic spasticity ICD-10-CM G80\.1 · Started 2020-03-04 · active/);
 assert.match(text,/synthetic migraine Already on this list\. Review it on its own\./);assert.doesNotMatch(text,/Synthetic asthma/);
 assert.match(block,/data-reconcile-all="problem">Reconcile all problems<\/button>/);assert.equal((block.match(/data-map-clinical="h[12]">Review<\/button>/g)||[]).length,2);
 assert.doesNotMatch(block,/type="checkbox"/);assert.doesNotMatch(text,internalTerms);
 assert.match(f.run('importedListBlock("medication")'),/Reconcile all medications/);assert.equal(f.run('importedListBlock("allergy")'),'');
 let reloaded=null;f.c.selectPatient=async(id)=>{reloaded=id;};
 f.c.api=async(path,method,body)=>{f.calls.push([path,method,plain(body)]);return {created:[{id:'n1'}],already_reconciled:0,needs_review:[]};};
 await f.click(f.button({reconcileAll:'problem'}));
 assert.deepEqual(f.calls.at(-1),['/api/v1/patients/p1/clinical-reconcile/problem','POST',{history_ids:['h1']}]);
 assert.equal(reloaded,'p1');assert.deepEqual(f.notices.at(-1),['1 problem added to the chart.',false]);
 f.c.me={role:'front_desk'};assert.equal(f.run('importedListBlock("problem")'),'');
 assert.match(clinical,/typeof importedListBlock==='function'\?importedListBlock\(k\):''/);
 assert.match(clinical,/mapping\?'<input type="hidden" name="reason" value="Reconciled from previous system records">'/,'reconciling one imported entry asks for no reason or confirmation box');
 assert.doesNotMatch(clinical,/review-ack/);
 console.log('PASS a reviewed imported list is accepted in one action');

 // Add as coverage: the imported insurance record pre-fills the coverage form for staff to confirm.
 const start=billing.indexOf('function importedCoverage(i){'),end=billing.indexOf('function chargeRow(');assert.ok(start>0&&end>start);
 let form='';
 const b=vm.createContext({esc,crypto:{randomUUID:()=>'request-1'},me:{role:'front_desk'},workspace:{patient:{given_name:'Avery Q',family_name:'Synthetic',birth_date:'1990-01-01'}},
  billingPayers:[{id:'payer-1',content:{name:'Synthetic Payer',active:true}},{id:'payer-2',content:{name:'Other Payer',active:true}}],
  showChartSection(){},openBillingEditor:html=>{form=html;},coveragePayerSetup:()=>'',dollars:v=>v??'',sourceNotice:()=>'<div>SOURCE NOTICE</div>',
  coveragePayerOptions:id=>`<option value="${id}" selected>payer</option>`,
  selectField:(name,label,values,value)=>`<select name="${name}" data-value="${esc(value)}"></select>`,
  billingField:(name,label,value='',type='text',max=0,required=false)=>`<input name="${name}" value="${esc(value)}" ${required?'required':''}>`});
 vm.runInContext(billing.slice(start,end),b);
 const record={source_history_id:'h9',policy:'p',source_data:{coverage:{payer_name:' synthetic payer ',member_id:'SYN-MEMBER-1',group_number:'SYN-GROUP',plan_name:'Synthetic PPO',relationship:'self',priority:'secondary',effective_date:'2023-01-01'}}};
 vm.runInContext('coverageEditor(null,record)',Object.assign(b,{record}));
 assert.match(form,/<h3>Add coverage from previous system<\/h3>/);assert.match(form,/data-source="h9"/);
 for(const [name,value] of [['member_id','SYN-MEMBER-1'],['group_number','SYN-GROUP'],['plan_name','Synthetic PPO'],['subscriber_name','Avery Q Synthetic'],['subscriber_birth_date','1990-01-01'],['effective_date','2023-01-01']])assert.match(form,new RegExp(`name="${name}" value="${value}"`));
 assert.match(form,/<option value="payer-1" selected>/);assert.match(form,/name="priority" data-value="secondary"/);assert.match(form,/name="relationship" data-value="self"/);
 assert.match(form,/<input type="hidden" name="reason" value="Added from previous system insurance record">/);
 assert.doesNotMatch(form,/type="checkbox"|SOURCE NOTICE/);assert.match(form,/>Save coverage<\/button>/);assert.doesNotMatch(visible(form),internalTerms);
 record.source_data.coverage.payer_name='Unlisted Payer';record.source_data.coverage.relationship='spouse';vm.runInContext('coverageEditor(null,record)',b);
 assert.match(form,/<option value="" selected>/);assert.match(visible(form),/Payer in the previous system: Unlisted Payer \. Choose the matching payer\./);assert.match(form,/name="subscriber_name" value="" required/);
 vm.runInContext('coverageEditor(null,{source_history_id:"h8",policy:"p",source_data:{policy_number:"LEGACY-1"}})',b);
 assert.match(form,/Reconcile source coverage/);assert.match(form,/SOURCE NOTICE/);assert.match(form,/type="checkbox" required/,'records from other import formats keep their review step');
 assert.match(app,/r\.kind==='insurance'&&r\.source_data\?\.coverage\?'Add as coverage':/);
 assert.match(app,/typeof importedContactBlock==='function'\?importedContactBlock\(\):''/);
 const panel=app.slice(app.indexOf('function renderHistory() {'),app.indexOf('function encounterWorkflow(){'));assert.match(panel,/<h2>Records from previous system<\/h2>/);assert.doesNotMatch(panel.replace(/\$\{[^`]*?\}/g,' '),/Source record|native chart|source history/i);
 console.log('PASS an imported insurance record pre-fills the coverage form without saving it');
})().catch(error=>{console.error(error);process.exit(1);});
