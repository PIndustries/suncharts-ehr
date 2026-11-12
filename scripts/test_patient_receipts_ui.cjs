// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const revenue=fs.readFileSync('web/patient-revenue.js','utf8'),billing=fs.readFileSync('web/billing.js','utf8'),app=fs.readFileSync('web/app.js','utf8'),hub=fs.readFileSync('web/patient-billing-workspace.js','utf8');
const receipt={id:'receipt-old',patient_id:'patient',appointment_id:'appointment-old',amount_cents:2500,allocated_cents:0,reversed_cents:0,voided:false,method:'external',occurred_on:'2026-10-25',created_at:'2026-10-25T14:00:00Z',reference:'SYNTHETIC-RECEIPT<&',reason:'PRIVATE STAFF EVIDENCE',hosted_checkout:{livemode:false,status:'paid',refunded_cents:0}};
const appointment={id:'appointment-old',title:'Earlier therapy visit',starts_at:'2026-10-25T14:00:00Z'},visit={id:'visit-old',appointment_id:appointment.id,status:'signed'};
function fixture(){
 const nodes={},calls=[],handlers={},frames=[];
 class Node{
  constructor(id){this.id=id;this.children=[];this.attributes={};this.dataset={};this.isConnected=true;this._html='';if(id)nodes[id]=this;}
  set innerHTML(value){this.children.forEach(n=>n.isConnected=false);this.children=[];this._html=value;if(value.includes('data-copay-receipt-view')){this.card=new Node();this.card.heading=new Node();this.append(this.card);}else this.card=null;}
  get innerHTML(){return this._html;}
  get firstChild(){return this.children[0]||null;}
  querySelector(s){if(s==='[data-copay-receipt-view]')return this.card;if(s==='h3')return this.heading;if(s==='form')return this.form||null;if(s==='.copay-print-source')return this.children.find(n=>n.className===s.slice(1));return null;}
  setAttribute(k,v){this.attributes[k]=v;}
  append(n){this.children.push(n);n.parentElement=this;}
  remove(){this.isConnected=false;this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
  scrollIntoView(){this.scrolled=true;}
  focus(){this.focused=true;}
  addEventListener(k,fn){this[k]=fn;}
 }
 for(const id of ['insurance-editor','encounter-billing-editor','encounter-copay-receipt'])new Node(id);
 const patient={id:'patient',given_name:'Avery <script>',family_name:'Synthetic',mrn:'LEGACY-123'},otherVisit={id:'visit-new',appointment_id:'appointment-new',status:'in_progress'};
 const context={patient,appointment,practiceName:'Synthetic Practice',printedAt:'2026-11-10'};
 const ctx={console,Date,Intl,URL,Symbol,encodeURIComponent,esc,date:String,human:String,me:{role:'owner',tenant_id:'tenant',user_id:'owner'},selected:'patient',chartSection:'insurance',encounterSection:'documentation',activeVisit:otherVisit,patientWorkspaceGeneration:0,patientDirectoryPreference:false,
  workspace:{patient,visits:[visit,otherVisit],appointments:[appointment,{id:'appointment-new',title:'Other appointment',starts_at:'2026-11-10'}],billing:{copays:[receipt]}},
  document:{addEventListener:(k,fn)=>(handlers[k]??=[]).push(fn),querySelector:s=>s==='.practice-identity strong'?{textContent:'Synthetic Practice'}:null,createElement:tag=>{const n=new Node();if(tag==='iframe'){frames.push(n);n.contentWindow={focus(){},print(){calls.push(['print']);}};}return n;}},$:id=>nodes[id]||null,
  workspaceResourceAllowed:()=>true,chartAreaEnabled:()=>true,notice:message=>calls.push(['notice',message]),run:fn=>ctx.pending=fn(),renderPatients(){},renderChart(){calls.push(['chart',ctx.activeVisit.id]);},setPatientDirectoryVisible(){},captureVisitDrafts(){calls.push(['note-drafts']);},captureBillingChargeDraft(){calls.push(['charge-drafts']);},
  setEncounterSection:step=>{ctx.encounterSection=step;ctx.chartSection='visits';calls.push(['section',step]);},showPatientBillingWorkspace:async options=>{calls.push(['hub',options]);ctx.hubState={patientId:options.patientId};return ctx.hubState;},patientBillingCurrent:s=>s===ctx.hubState,
  showPatientBillingDocument:async(...args)=>calls.push(['hub-receipt',...args])};
 ctx.api=async(path,method='GET')=>{calls.push(['api',path,method]);if(path.includes('/copay-receipts/'))return {receipt:structuredClone(receipt),context};if(path.endsWith('/workspace'))return ctx.workspace;if(path==='/api/v1/billing/payers')return {items:[]};if(path.endsWith('/billing'))return ctx.workspace.billing;return {};};
 vm.createContext(ctx);vm.runInContext(billing,ctx);vm.runInContext(revenue,ctx);
 // Exercise the real chart fetch/publication guard, with rendering isolated from unrelated panels.
 vm.runInContext(app.slice(app.indexOf('async function selectPatient('),app.indexOf('async function openPatientEncounter(')),ctx);
 ctx.captureBillingChargeDraft=()=>calls.push(['charge-drafts']);
 vm.runInContext("insuranceAppointmentSelection.set(selected,'appointment-old')",ctx);
 return {ctx,nodes,calls,handlers,frames,context,Node};
}
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
(async()=>{
 let f=fixture();const editor=f.nodes['encounter-billing-editor'];editor.innerHTML='unsaved charge editor';
 await f.ctx.showCopayReceipt(receipt.id,appointment.id);
 assert.equal(f.ctx.activeVisit.id,visit.id);assert.equal(f.ctx.chartSection,'visits');assert.equal(f.ctx.encounterSection,'charges');
 assert.equal(editor.innerHTML,'unsaved charge editor');assert(f.calls.some(c=>c[0]==='charge-drafts'));assert(f.calls.some(c=>c[0]==='note-drafts'));
 const host=f.nodes['encounter-copay-receipt'];assert(host.card.heading.focused);assert.equal(f.frames.length,0,'ordinary receipt view creates no iframe');
 for(const text of ['$25.00','Earlier therapy visit','2026-10-25','Payment captured','Synthetic Practice','Powered by P.Industries'])assert(host.innerHTML.includes(text),text);
 assert(!host.innerHTML.includes('PRIVATE STAFF EVIDENCE'));assert(!host.innerHTML.includes('<script>'));assert.match(host.innerHTML,/Avery &lt;script&gt;/);assert.match(host.innerHTML,/SYNTHETIC-RECEIPT&lt;&amp;/);
 assert(f.calls.filter(c=>c[0]==='api').every(c=>c[2]==='GET'),'view never refreshes or creates a payment');
 const button={dataset:{},disabled:false,hasAttribute:k=>k==='data-print-copay-card',closest:s=>s==='[data-copay-receipt-view]'?host.card:null};
 for(const listener of f.handlers.click)listener({target:{closest:s=>s==='button'?button:null},preventDefault(){}});
 assert.equal(f.frames.length,1);assert(!f.calls.some(c=>c[0]==='print'),'wait for print document and branding to load');
 let frame=f.frames[0];assert.equal(frame.attributes.sandbox,'allow-same-origin allow-modals');assert.match(frame.srcdoc,/default-src 'none'/);assert.match(frame.srcdoc,/href="\/patient-print\.css"/);assert.match(frame.srcdoc,/LEGACY-123/);frame.load();assert(f.calls.some(c=>c[0]==='print'));
 f.ctx.printCopayReceiptCard(host.card,button);frame=f.frames[1];f.ctx.me={role:'owner',tenant_id:'other'};frame.load();assert.equal(f.calls.filter(c=>c[0]==='print').length,1,'late iframe cannot print across sign-in changes');

 // Previsit and clinical-denied viewers use the same patient billing receipt surface, never another encounter.
 for(const clinical of [true,false]){f=fixture();if(clinical)f.ctx.workspace.visits=[];else f.ctx.workspaceResourceAllowed=resource=>resource!=='clinical';await f.ctx.showCopayReceipt(receipt.id,appointment.id);assert.equal(f.ctx.activeVisit.id,'visit-new');assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[0]==='hub')[1])),{patientId:'patient',tab:'payments',mode:'test'});assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[0]==='hub-receipt').slice(1))),['receipt','receipt-old',{appointmentId:'appointment-old'}]);assert.equal(f.calls.filter(c=>c[0]==='api').length,1,'billing fallback does not read clinical workspace');}

 // Every pre-existing form stays intact; receipt action cannot silently discard coverage input.
 f=fixture();f.nodes['insurance-editor'].form={values:{member:'unsaved'}};await f.ctx.showCopayReceipt(receipt.id,appointment.id);assert.equal(f.nodes['insurance-editor'].form.values.member,'unsaved');assert(!f.calls.some(c=>c[0]==='api'));assert.match(f.calls[0][1],/Save or cancel/);
 for(const change of [c=>c.selected='other',c=>c.me={...c.me},c=>c.chartSection='overview',c=>vm.runInContext("insuranceAppointmentSelection.set(selected,'appointment-new')",c),(_c,n)=>n['insurance-editor'].append({})]){
  f=fixture();const wait=deferred();f.ctx.api=()=>wait.promise;const pending=f.ctx.showCopayReceipt(receipt.id,appointment.id);change(f.ctx,f.nodes);wait.resolve({receipt,context:f.context});await pending;assert(!f.calls.some(c=>['section','hub','chart'].includes(c[0])),'late receipt read cannot navigate a changed context');
 }
 // A second patient selection while the target encounter is loading cannot publish the old chart.
 f=fixture();const normal=f.ctx.api,wait=deferred();f.ctx.api=(path,...args)=>path.endsWith('/workspace')?wait.promise:normal(path,...args);const pending=f.ctx.showCopayReceipt(receipt.id,appointment.id);await new Promise(setImmediate);f.ctx.selected='other';wait.resolve(f.ctx.workspace);await pending;assert(!f.calls.some(c=>c[0]==='chart'||c[0]==='section'));
 for(const mismatch of [{id:'wrong'},{patient_id:'other'},{appointment_id:'other'}]){f=fixture();f.ctx.api=async()=>({receipt:{...receipt,...mismatch},context:f.context});await assert.rejects(()=>f.ctx.showCopayReceipt(receipt.id,appointment.id),/does not match/);assert(!f.calls.some(c=>c[0]==='section'));}

 // Patient Billing's actual document controller uses a compact card too and rejects a stale/wrong appointment.
 f=fixture();const preview=new f.Node('preview'),s={patientId:'patient',host:{querySelector:()=>preview}};f.ctx.hubState=s;vm.runInContext('let patientBillingWorkspace;',f.ctx);f.ctx.s=s;vm.runInContext('patientBillingWorkspace=s',f.ctx);vm.runInContext(hub.slice(hub.indexOf('async function showPatientBillingDocument('),hub.indexOf("document.addEventListener('submit'",hub.indexOf('async function showPatientBillingDocument('))),f.ctx);
 await f.ctx.showPatientBillingDocument('receipt',receipt.id,{appointmentId:appointment.id});assert(preview.card);assert.equal(f.frames.length,0);assert.match(preview.children.at(-1).textContent,/Close receipt/);
 await f.ctx.showPatientBillingDocument('receipt',receipt.id,{appointmentId:'wrong'});assert.match(preview.innerHTML,/does not match/);assert.equal(f.frames.length,0);

 // Both compact and printable copies retain correction semantics without changing receipt data.
 f=fixture();const before=JSON.stringify(receipt);
 for(const renderer of [f.ctx.copayReceiptCardMarkup,f.ctx.copayReceiptDocument]){
  const voided=renderer({...receipt,voided:true},f.context);assert.match(voided,/Voided/);assert.match(voided,/Original recorded amount/);assert(!voided.includes('Unapplied credit'));
  const corrected=renderer({...receipt,allocated_cents:2500,reversed_cents:2500},f.context);assert.match(corrected,/does not establish that a refund was issued/);assert(!corrected.includes('Unapplied credit'));
  const refunded=renderer({...receipt,hosted_checkout:{...receipt.hosted_checkout,refunded_cents:500}},f.context);assert.match(refunded,/\$20\.00/);assert.match(refunded,/refund/i);assert.match(refunded,/Original charge allocations/);
  assert.match(renderer({...receipt,hosted_checkout:{...receipt.hosted_checkout,status:'needs_review'}},f.context),/reconciliation/);
  assert.match(renderer(receipt,{...f.context,appointment:null}),/appointment-old/);
 }
 assert.equal(JSON.stringify(receipt),before);assert.match(f.ctx.copayReceiptMarkup([receipt]),/data-appointment="appointment-old"/);
 console.log('PASS receipt navigation: exact encounter or patient billing, GET-only, draft/context isolation, compact branded copy, explicit load-safe printing and immutable correction states');
})().catch(error=>{console.error(error);process.exitCode=1;});
