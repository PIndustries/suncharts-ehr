// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic records only. Exercise the real page renderers and delegated controls.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const read=name=>fs.readFileSync(`web/${name}.js`,'utf8'),app=read('app');
const stamp='2026-11-24T12:00:00Z',day='2026-11-24';
function fixture(files=[]){
 const hosts={},handlers={},calls=[];
 const node=()=>({innerHTML:'',hidden:false,closest:()=>null,after(n){this.afterNode=n},insertBefore(n){hosts[n.id]=n},append(n){hosts[n.id]=n}});
 for(const id of ['chart','appointments-panel','lab-workspace','referrals-panel','immunizations-panel','health-history-panel','documents-panel','care-pathways-panel','patient-intake-panel'])hosts[id]=node();
 const c=vm.createContext({console,Map,Set,WeakMap,Date,Intl,URLSearchParams,structuredClone,crypto:{randomUUID:()=> 'synthetic-request'},selected:'synthetic-patient',me:{role:'clinician',user_id:'synthetic-staff'},activeVisit:null,chartSection:'orders',hosts,calls,
 document:{createElement:node,addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},$:id=>hosts[id]||null,
 esc:s=>String(s??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),human:s=>String(s??'').replaceAll('_',' '),
 workspace:{labs:{orders:[],reports:[],specimens:[],acknowledgments:[]},history:[],visits:[],appointments:[],clinical:{items:[]},billing:{accounts:[],coverages:[]}},
 canDocument:()=>true,billingWrite:()=>['owner','clinician'].includes(c.me.role),applyChartSection:()=>{},showChartSection:()=>{},notice:()=>{},run:fn=>{c.pending=fn();return c.pending},api:async(path)=>{calls.push(path);return {items:[]}},
 documentCategories:['laboratory','insurance'],documentStates:new Map(),documentDrafts:new Map(),documentSelect:(name,label,values,current)=>`<label>${label}<select name="${name}">${values.map(v=>`<option value="${v}" ${v===current?'selected':''}>${v}</option>`).join('')}</select></label>`,documentCategoryLabel:v=>v==='insurance'?'Insurance card':v,documentCanEdit:()=>true
 });
 vm.runInContext(read('display-format'),c);
 vm.runInContext(app.slice(app.indexOf('// Chart list layout helpers.'),app.indexOf("if(typeof document!=='undefined'){")),c);
 vm.runInContext('chartResetSectionSheets=()=>{};chartOpenEditor=id=>$(id);',c);
 for(const file of files)vm.runInContext(read(file),c,{filename:`web/${file}.js`});
 return {c,hosts,calls,run:code=>vm.runInContext(code,c),html:id=>hosts[id].innerHTML,async event(name,target){for(const fn of handlers[name]||[])fn({target,preventDefault(){},stopImmediatePropagation(){}});await c.pending;},async click(dataset){const b={dataset,type:'button',closest:()=>hosts['lab-workspace'],hasAttribute:name=>Object.keys(dataset).some(k=>'data-'+k.replace(/[A-Z]/g,x=>'-'+x.toLowerCase())===name)};await this.event('click',{closest:selector=>selector==='button'||selector.split(',').some(part=>{const m=part.match(/^\[([^\]]+)\]$/);return m&&b.hasAttribute(m[1])})?b:null});}};
}
const beforeTemplates=html=>html.split('<template')[0];
function headings(html,names){for(const name of names)assert.ok(html.includes(`<th scope="col">${name}</th>`),`Missing heading: ${name}`);}
function pill(html,status,label){assert.ok(html.includes(`class="status-badge ${status}">${label}</span>`),`Missing ${label} pill`);}
function noIso(html){assert.doesNotMatch(html,/2026-11-24(?:T|<| ·)/);}
(async()=>{
 let f=fixture(['labs']);
 f.c.workspace.labs.orders=[{id:'o1',status:'in_progress',placed_at:stamp,content:{title:'Synthetic & test'}},{id:'o2',status:'completed',placed_at:stamp,content:{title:'Synthetic second'}}];
 const report=(id,order,flag,version=2)=>({id,order_id:order,status:'final',version,content:{reported_at:stamp,observations:[{label:'Synthetic result',value_type:'numeric',number:5,flag}]}});
 f.c.workspace.labs.reports=[report('r1','o1','critical_high'),report('r2','o2','high')];
 f.c.workspace.labs.acknowledgments=[{report_id:'r1',version:1}];
 f.run('renderLabs()');let html=f.html('lab-workspace');headings(html,['Order','Ordered','Status','Result','Abnormal flag','Review']);pill(html,'critical','Critical');pill(html,'abnormal','Abnormal');pill(html,'in_progress','In progress');assert.equal((html.match(/1 report\(s\) need review/g)||[]).length,2);assert.match(html,/data-ack-order="o1"/);assert.match(html,/Nov 24, 2026/);assert.match(html,/Synthetic &amp; test/);noIso(html);
 f.run("showOrder=id=>calls.push('open:'+id)");f.hosts['lab-order-detail']={querySelectorAll:()=>[{dataset:{report:'already-reviewed'},scrollIntoView:()=>{throw Error('Wrong report selected')}},{dataset:{report:'r1'},scrollIntoView:()=>{},querySelector:()=>({focus:()=>f.calls.push('review-note')})}]};await f.click({ackOrder:'o1',ackReport:'r1'});assert.deepEqual(f.calls,['open:o1','review-note']);
 f.c.workspace.labs.acknowledgments.push({report_id:'r1',version:2});f.run('renderLabs()');assert.doesNotMatch(f.html('lab-workspace'),/data-ack-order="o1"/);
 f.c.workspace.labs.orders=[];f.run('renderLabs()');html=f.html('lab-workspace');headings(html,['Order','Abnormal flag']);assert.match(html,/data-new-order/);assert.match(html,/No orders recorded\./);
 console.log('PASS orders: review counts by revision, critical/abnormal flags, status, acknowledge control, empty headings');

 f=fixture(['referrals']);f.c.records={items:[{id:'r1',status:'sent',created_at:stamp,version:1,content:{recipient:'Synthetic clinic',requested_service:'Synthetic referral',clinical_reason:'Synthetic reason',follow_up_due:day}},{id:'r2',status:'draft',created_at:stamp,content:{recipient:'Other clinic'}}],status:'',documents:[]};f.run('referralStates.set(selected,records);showReferrals()');html=beforeTemplates(f.html('referrals-panel'));headings(html,['To','Reason','Created','Status','Follow-up due']);assert.doesNotMatch(html,/>Sent<\/th>/);assert.match(html,/2 matching of 2 loaded/);assert.match(html,/records only/);assert.match(html,/sends nothing/);for(const status of f.run('referralStatuses'))assert.match(html,new RegExp(`value="${status}"`));pill(html,'sent','Sent');noIso(html);
 await f.event('change',{name:'referral_status_filter',value:'sent'});html=beforeTemplates(f.html('referrals-panel'));assert.match(html,/1 matching of 2 loaded/);assert.doesNotMatch(html,/Other clinic/);
 f.c.records.items=[];f.run('showReferrals()');html=f.html('referrals-panel');headings(html,['To','Created','Follow-up due']);assert.match(html,/data-referral-new/);assert.match(html,/No referrals recorded\./);
 console.log('PASS referrals: all statuses, working filter/count, honest created date, follow-up date, local-only note, empty headings');

 f=fixture(['immunizations']);f.c.records={items:['administered','historical','not_given'].map((kind,i)=>({id:'i'+i,patient_id:'synthetic-patient',version:1,content:{record_type:kind,status:kind==='not_given'?'not_done':'completed',vaccine_name:'Synthetic vaccine',occurred_on:day,lot_number:'SYN-LOT',site:'Left arm',route:'IM'}})),status:'',performers:[]};f.run('immunizationStates.set(selected,records);rememberImmunizationRows(selected,records.items);showImmunizations()');html=beforeTemplates(f.html('immunizations-panel'));headings(html,['Vaccine','Date','Record type','Dose','Lot','Site / route','Status']);for(const word of ['Given','Historical','Not given','SYN-LOT','Left arm / IM','3 loaded','not checked','immunization registry'])assert.ok(html.includes(word),word);pill(html,'not_given','Not given');noIso(html);
 f.c.api=async path=>{f.calls.push(path);return {items:[],next_cursor:null}};await f.event('change',{name:'immunization_filter',value:'not_done'});assert.match(f.calls[0],/status=not_done/);assert.match(beforeTemplates(f.html('immunizations-panel')),/1 loaded/);
 f.c.records.items=[];f.run("immunizationStates.set(selected,records);showImmunizations()");html=f.html('immunizations-panel');headings(html,['Vaccine','Lot','Site / route']);assert.match(html,/data-immunization-new="administered"/);assert.match(html,/No immunizations recorded\./);
 console.log('PASS immunizations: filter, count, registry limitations, record type, lot, site/route, status, date, empty headings');

 f=fixture(['health-history']);f.c.records={items:[{id:'h1',version:1,content:{title:'Synthetic surgery',kind:'surgery',status:'completed',onset_date:day}},{id:'h2',version:1,content:{title:'Synthetic dental',kind:'dental',status:'active',onset_date:day}}],kind:'',status:''};f.run('healthHistoryStates.set(selected,records);showHealthHistory()');html=beforeTemplates(f.html('health-history-panel'));headings(html,['Procedure','Kind','Date','Status','Notes']);assert.match(html,/name="history_kind"/);assert.match(html,/name="history_status"/);assert.match(html,/not that there is no history/);assert.match(html,/2 matching of 2 loaded/);pill(html,'completed','Completed');noIso(html);
 await f.event('change',{name:'history_kind',value:'dental'});assert.match(beforeTemplates(f.html('health-history-panel')),/1 matching of 2 loaded/);assert.doesNotMatch(beforeTemplates(f.html('health-history-panel')),/Synthetic surgery/);await f.event('change',{name:'history_status',value:'resolved'});html=f.html('health-history-panel');headings(html,['Kind','Status']);assert.match(html,/No surgical or dental history recorded\./);assert.match(html,/data-history-new="surgery"/);
 console.log('PASS surgical/dental: kind/status filters and columns, count, empty-history note, dates, empty headings');

 f=fixture(['document-files']);f.run('documentFileDetail=(entry)=>`<p>Preview ${esc(entry.content.title)}</p>`;');f.c.records={items:[{id:'d1',uploaded_at:stamp,filename:'synthetic.pdf',content:{title:'Synthetic file',category:'laboratory',document_date:day,status:'active'}},{id:'d2',filename:'archived.pdf',uploaded_at:stamp,content:{title:'Archived synthetic file',category:'laboratory',status:'archived'}}],status:'active',category:''};f.run("documentStates.set(selected,records);chartSection='documents';renderDocumentFileBrowser(records)");html=f.html('documents-panel');headings(html,['Name','Category','Date','Added by','Status']);assert.match(html,/name="document_status_filter"/);for(const status of ['active','archived','entered_in_error'])assert.match(html,new RegExp(`value="${status}"`));
 assert.match(html,/role="status">1 file<\/p>/);
 assert.match(html,/1 archived or entered in error file is not shown/);
 assert.match(html,/>Laboratory</);
 assert.match(html,/id="chart-file-preview"[^>]*\bhidden><\/section>/);
 assert.equal(f.hosts['documents-panel'].afterNode,f.hosts['patient-intake-panel']);assert.equal(f.hosts['patient-intake-panel'].hidden,false);noIso(html);
 f.c.records.next_cursor='synthetic-next';f.c.records.fileSearch='missing';f.run('renderDocumentFileBrowser(records)');html=f.html('documents-panel');
 assert.match(html,/role="status">0 found so far · More files available<\/p>/);
 assert.match(html,/No matching files in the loaded results/);
 assert.match(html,/data-document-more>Search more files</);
 delete f.c.records.next_cursor;delete f.c.records.fileSearch;
 f.run("documentFileViews.set(selected,{id:'d1',context:null});renderDocumentFileBrowser(records)");html=f.html('documents-panel');
 assert.match(html,/id="chart-file-preview"[^>]*><p>Preview Synthetic file<\/p>/);
 assert.match(html,/data-file-open="d1" aria-current="true"/);
 f.c.records.status='archived';f.run('renderDocumentFileBrowser(records)');html=f.html('documents-panel');pill(html,'archived','Archived');assert.match(html,/Archived synthetic file/);
 f.c.records.items=[];f.run('renderDocumentFileBrowser(records)');html=f.html('documents-panel');headings(html,['Name','Category','Status']);assert.match(html,/data-document-new/);assert.match(html,/No files recorded for this patient\./);
 console.log('PASS files: status and results, partial search, active preview, intake placement, dates, empty headings');

 f=fixture();f.run(app.slice(app.indexOf('function renderHistory()'),app.indexOf('\nfunction encounterWorkflow')));f.c.workspace.history=['medical_problem','lab_order','insurance','claim','appointment'].map((kind,i)=>({id:'source'+i,kind,imported_at:stamp,source_instance:'Synthetic previous system',data:{title:'Synthetic imported record'}}));f.c.workspace.clinical.items=[{source_history_id:'source0'}];f.c.workspace.billing.coverages=[{source_history_id:'source2'}];f.c.claimRows=[{patient_id:'another-synthetic-patient',source_history_id:'source3'}];f.run('renderHistory()');html=beforeTemplates(f.html('source-history'));headings(html,['Record','Type','Imported','Source','Reconciliation','Actions']);assert.match(html,/Kept as they were, not signed in SunCharts/);for(const action of ['clinical','lab','billing','claim','appointment'])assert.match(html,new RegExp(`data-map-${action}=`));pill(html,'reconciled','Reconciled');pill(html,'pending','Pending');assert.equal((html.match(/>Reconciled<\/span>/g)||[]).length,2);noIso(html);
 f.c.me.role='read_only';f.run('renderHistory()');assert.doesNotMatch(beforeTemplates(f.html('source-history')),/data-map-/);f.c.workspace.history=[];f.run('renderHistory()');html=f.html('source-history');headings(html,['Record','Reconciliation','Actions']);assert.match(html,/No imported records recorded\./);
 console.log('PASS imported records: provenance note, list reconciliation controls and state, permissions, dates, empty headings');

 f=fixture(['care-pathways']);f.c.runs=[{id:'w1',patient_id:'synthetic-patient',definition_name:'Synthetic workflow',created_at:stamp,status:'active',steps:[]},{id:'w2',patient_id:'synthetic-patient',definition_name:'Synthetic second workflow',created_at:stamp,status:'completed',steps:[]}];f.run('patientPathways=runs;renderCarePathwayPanel()');html=beforeTemplates(f.html('care-pathways-panel'));headings(html,['Workflow','Started','Status']);assert.match(html,/data-pathway-refresh/);assert.match(html,/Step-by-step plans/);assert.match(html,/Patient workflows <span class="pill">2/);assert.match(html,/id="chart-pathway-board"><section class="pathway-board/);assert.match(html,/data-pathway-select="w2"/);pill(html,'active','Active');noIso(html);
 await f.click({pathwaySelect:'w2'});assert.ok(f.calls.some(path=>path.includes('/w2/events')));assert.equal(f.run('selectedPathwayId'),'w2');await f.click({pathwayRefresh:''});assert.ok(f.calls.includes('/api/v1/care-pathways/definitions'));
 f.run('patientPathways=[];renderCarePathwayPanel()');html=f.html('care-pathways-panel');headings(html,['Workflow','Started','Status']);assert.match(html,/data-chart-detail="workflow-new"/);assert.match(html,/No practice workflows recorded\./);assert.match(html,/data-pathway-refresh/);
 console.log('PASS workflows: refresh and selection handlers, inline board, count, explanation, status/date, empty headings');

 // Syntax for every touched script, plus shared CSS coverage for all record status families.
 for(const file of ['app','labs','referrals','immunizations','health-history','document-files','care-pathways'])new vm.Script(read(file),{filename:`web/${file}.js`});
 const css=fs.readFileSync('web/frame.css','utf8');for(const status of ['critical','abnormal','entered_in_error','reconciled','active','pending','completed','archived'])assert.ok(css.includes('.'+status),`Missing status colour: ${status}`);
 console.log('PASS script syntax and status colour rules');
})().catch(error=>{console.error(error);process.exitCode=1});
