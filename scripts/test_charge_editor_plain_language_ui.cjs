// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}
const handlers={},nodes={},ctx={console,Date,Intl,URL,URLSearchParams,crypto:{randomUUID:()=>'synthetic-request'},selected:'patient',me:{role:'owner'},chartSection:'billing',
 workspace:{appointments:[],visits:[{id:'visit-a',appointment_id:'appt-a',created_at:'2026-11-13T14:00:00Z'}],billing:{accounts:[],coverages:[{id:'cov-p',content:{priority:'primary',payer_id:'payer-a',member_id:'SYN-1',status:'active',effective_date:'2026-01-01'}}],entries:[]}},
 openedForm:null,
 $:id=>id==='billing-account-form'?ctx.openedForm:(nodes[id]??={id,innerHTML:'',dataset:{},scrollIntoView(){},replaceChildren(){this.innerHTML='';},querySelector:()=>null,querySelectorAll:()=>[]}),
 document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),human:v=>v,date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),payerName:()=>'Synthetic payer',billingCan:()=>true,
 notice(){},run:fn=>fn(),showChartSection(){},setEncounterSection(){},
 openBillingEditor(html){nodes['billing-editor'].innerHTML=html;}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/fees.js','utf8'),ctx);
(async()=>{
 // A brand-new charge editor for an encounter dated 2026-11-13 with one active primary coverage.
 ctx.activeVisit={id:'visit-a',appointment_id:'appt-a',status:'in_progress'};ctx.revenueServiceDate=()=>'2026-11-13';
 const diagnosisField={value:''},diagnosisHost={innerHTML:''};
 ctx.openedForm={dataset:{},elements:{visit_id:{value:'visit-a'},service_date:{value:'2026-11-13'},coverage_id:{value:'cov-p'}},querySelector:()=>null,querySelectorAll:()=>[{dataset:{diagnosesDefault:'pending'},querySelector:selector=>selector==='[name="diagnoses"]'?diagnosisField:diagnosisHost}]};
 ctx.api=async()=>({version:3,diagnoses:[{code:'G24.3',display:'Synthetic diagnosis A'}]});
 ctx.accountEditor(null,null,true);
 const html=nodes['billing-editor'].innerHTML,details=html.slice(html.indexOf('<details data-visit-charge-options>')),feeHtml=details.slice(details.indexOf('data-fee-context'),details.indexOf('name="notes"'));
 await new Promise(setImmediate);
 assert.match(html,/<h3>Charges for this encounter<\/h3>/);assert.doesNotMatch(html,/Record encounter procedures/);
 assert.doesNotMatch(html,/>Save charges<|Save draft account/,'the charge table saves itself; nothing is pressed');
 assert.doesNotMatch(html,/name="code_system"|Reason \/ source review/,'no code system box and no reason box are shown for an encounter charge');
 assert.match(html,/data-charge-status role="status"/,'a quiet status line sits beside the table');
 assert.doesNotMatch(html,/Enter the total for each line\.|Tick the diagnoses that support each procedure\.|Record each service once/,'the charge editor shows no duplicate or long claims wording');
 assert.doesNotMatch(html,/Line totals are the complete charge|Search installed procedure catalogs|Catalog selection does not determine fees/);
 assert.doesNotMatch(html,/Choose the saved encounter diagnoses/);
 assert.match(html,/>Amount</);assert.match(html,/>Use practice price</);assert.match(html,/<summary>Code list this came from<\/summary>/);
 assert.doesNotMatch(html,/>Diagnoses for this service</,'the line is answered by the letters, not a box to type codes into');
 assert.doesNotMatch(html,/<h3>[^<]*Encounter|Saved visit diagnoses|Diagnosis pointers/,'no developer wording anywhere on the charge editor');
 assert.match(details,/Insurance on Nov 13, 2026/,'coverage heading uses the friendly date');assert.doesNotMatch(html,/Insurance for 2026-11-13|Insurance for 2026<\/h4>/);
 assert.match(feeHtml,/Choose where the encounter took place\./,'the encounter-place note is shown above the facility and setting choices');assert.doesNotMatch(feeHtml,/Provider comes from the selected encounter|owner-approved schedule can supply fees/);
 assert.doesNotMatch(html,/Fees require an approved schedule|Manual amounts remain available/,'no jargon fee wording is shown in the charge editor');
 // The fee-context status line is filled with the reason the server returns for the encounter.
 const status={textContent:''},facility={value:''},setting={value:''};
 const contextHost={dataset:{},querySelector:q=>q==='[data-fee-context-status]'?status:q==='[name="fee_facility"]'?facility:q==='[name="fee_setting"]'?setting:null};
 const feeForm={isConnected:true,dataset:{patient:'patient'},elements:{visit_id:{value:'visit-a'},service_date:{value:'2026-11-13'}},querySelector:q=>q==='[data-fee-context]'?contextHost:null,querySelectorAll:()=>[]};
 ctx.api=async()=>({facilities:[{id:'facility-a',name:'Synthetic Clinic'}],facility_id:'facility-a',setting:'nonfacility',reason:'Prices fill in from your fee schedule when one applies. You can always type the amount.'});
 await ctx.loadFeeContext(feeForm);
 assert.equal(status.textContent,'Prices fill in from your fee schedule when one applies. You can always type the amount.','the fee note shown under the encounter-place choices is the plain server reason');
 // The unsaved line the editor opened arrives with the encounter's one diagnosis lettered and taken.
 assert.match(diagnosisHost.innerHTML,/<legend>Diagnoses<\/legend>/,'one plain word over the letters');
 assert.match(diagnosisHost.innerHTML,/aria-pressed="true"/,'the encounter\u2019s diagnosis is taken for the new line');
 assert.match(diagnosisHost.innerHTML,/<span class="charge-dx-chip-letter">A<\/span>/,'lettered A, the same letter the list above the table shows');
 assert.match(diagnosisHost.innerHTML,/A \(G24\.3\)/,'and the line says in plain words what it points at');
 assert.doesNotMatch(diagnosisHost.innerHTML,/type="checkbox"|Ticked for you|ticked for you/,'nothing is ticked, and the old tick wording is gone');
 assert.equal(diagnosisField.value,'G24.3','the encounter diagnosis is still the answer the new line starts from');
 console.log('PASS plain-language charge table: friendly heading, no save button, no code-system or reason box, plain fee and diagnosis wording, dated insurance heading');
})().catch(error=>{console.error(error);process.exitCode=1;});
