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
 // A brand-new charge editor for a visit dated 2026-11-13 with one active primary coverage.
 ctx.activeVisit={id:'visit-a',appointment_id:'appt-a',status:'in_progress'};ctx.revenueServiceDate=()=>'2026-11-13';
 const diagnosisField={value:''},diagnosisHost={innerHTML:''};
 ctx.openedForm={dataset:{},elements:{visit_id:{value:'visit-a'},service_date:{value:'2026-11-13'},coverage_id:{value:'cov-p'}},querySelector:()=>null,querySelectorAll:()=>[{dataset:{diagnosesDefault:'pending'},querySelector:selector=>selector==='[name="diagnoses"]'?diagnosisField:diagnosisHost}]};
 ctx.api=async()=>({version:3,diagnoses:[{code:'G24.3',display:'Synthetic diagnosis A'}]});
 ctx.accountEditor(null,null,false);
 const html=nodes['billing-editor'].innerHTML,feeHtml=html.slice(html.indexOf('data-fee-context'),html.indexOf('id="billing-charge-lines"'));
 await new Promise(setImmediate);
 assert.match(html,/<h3>Charges for this visit<\/h3>/);assert.doesNotMatch(html,/Record encounter procedures/);
 assert.match(html,/>Save charges</);assert.doesNotMatch(html,/Save draft account/);
 assert.match(html,/<p class="muted">Enter the total for each line\. It is not multiplied by the units\.<\/p>/);
 assert.doesNotMatch(html,/Line totals are the complete charge|Search installed procedure catalogs|Catalog selection does not determine fees/);
 assert.match(html,/<p class="muted">Tick the diagnoses that support each procedure\.<\/p>/);
 assert.doesNotMatch(html,/Choose the saved encounter diagnoses/);
 assert.match(html,/Insurance on Nov 13, 2026/,'coverage heading uses the friendly date');assert.doesNotMatch(html,/Insurance for 2026-11-13|Insurance for 2026<\/h4>/);
 assert.match(feeHtml,/Choose where the visit took place\./,'the visit-place note is shown above the facility and setting choices');assert.doesNotMatch(feeHtml,/Provider comes from the selected encounter|owner-approved schedule can supply fees/);
 assert.doesNotMatch(html,/Fees require an approved schedule|Manual amounts remain available/,'no jargon fee wording is shown in the charge editor');
 // The fee-context status line is filled with the reason the server returns for the visit.
 const status={textContent:''},facility={value:''},setting={value:''};
 const contextHost={dataset:{},querySelector:q=>q==='[data-fee-context-status]'?status:q==='[name="fee_facility"]'?facility:q==='[name="fee_setting"]'?setting:null};
 const feeForm={isConnected:true,dataset:{patient:'patient'},elements:{visit_id:{value:'visit-a'},service_date:{value:'2026-11-13'}},querySelector:q=>q==='[data-fee-context]'?contextHost:null,querySelectorAll:()=>[]};
 ctx.api=async()=>({facilities:[{id:'facility-a',name:'Synthetic Clinic'}],facility_id:'facility-a',setting:'nonfacility',reason:'Prices fill in from your fee schedule when one applies. You can always type the amount.'});
 await ctx.loadFeeContext(feeForm);
 assert.equal(status.textContent,'Prices fill in from your fee schedule when one applies. You can always type the amount.','the fee note shown under the visit-place choices is the plain server reason');
 // The unsaved line the editor opened arrives pre-ticked with the plain note.
 assert.match(diagnosisHost.innerHTML,/<p class="muted">The diagnoses from this visit are ticked for you\. Untick any that do not apply\.<\/p>/);
 assert.doesNotMatch(diagnosisHost.innerHTML,/A new line starts with this visit's diagnoses|copied from the visit as saved now/);
 assert.match(diagnosisHost.innerHTML,/data-charge-diagnosis="G24.3"  checked/,'behaviour of the default tick is unchanged');
 assert.equal(diagnosisField.value,'G24.3','the visit diagnosis is still offered on the new line');
 console.log('PASS plain-language charge editor: friendly heading, save label, line-total and diagnosis notes, dated insurance heading and simple fee-context wording');
})().catch(error=>{console.error(error);process.exitCode=1;});
