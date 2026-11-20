// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}
const nodes={},captureHandlers={},ctx={console,Date,Intl,URL,URLSearchParams,crypto:{randomUUID:()=>'synthetic-request'},selected:'patient',me:{role:'owner'},chartSection:'billing',
 workspace:{appointments:[],visits:[{id:'visit-a',appointment_id:'appt-a',created_at:'2026-11-13T14:00:00Z'}],billing:{accounts:[],coverages:[],entries:[]}},
 // The charge form is held as text here, so the editor host never answers for the form itself.
 $:id=>id==='billing-account-form'?ctx.openedForm:(nodes[id]??={id,innerHTML:'',dataset:{},scrollIntoView(){},replaceChildren(){this.innerHTML='';},querySelector:()=>null,querySelectorAll:()=>[]}),
 document:{addEventListener:(name,fn,useCapture)=>{if(useCapture&&name==='submit')captureHandlers.submit=fn;}},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),human:v=>v,date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),payerName:()=>'Synthetic payer',billingCan:()=>true,
 notice(){},run:fn=>fn(),showChartSection(){},setEncounterSection(){}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/fees.js','utf8'),ctx);
// A row is read up to the diagnosis host that follows it, which is where its cells end.
const chargeLine=html=>{const start=html.indexOf('<tr class="billing-charge-row"');const end=html.indexOf('</tr>',start);return html.slice(start,end);};
(async()=>{
 ctx.revenueServiceDate=()=>'2026-11-13';
 ctx.api=async()=>({version:3,diagnoses:[]});
 // Opened from inside the encounter: the charge lines come first, everything else is tucked away.
 ctx.chartSection='visits';ctx.activeVisit={id:'visit-a',appointment_id:'appt-a',status:'in_progress'};
 ctx.accountEditor(null,null,true);
 const visit=nodes['encounter-billing-editor'].innerHTML,box='<details class="charge-more-options">';
 assert.match(visit,/<section class="charge-encounter-head" data-visit-charge-options><h4>Insurance and dates<\/h4>/,'insurance and the date of service open the form, as on a paper encounter form');
 assert.ok(visit.indexOf('data-visit-charge-options')<visit.indexOf('id="billing-charge-lines"'),'above the procedures');
 assert.match(visit,/<details class="charge-more-options"><summary>Fees and notes<\/summary>/,'fees and notes are tucked under the procedures');
 // The encounter form carries the claim details a paper encounter form has: prior authorization,
 // dates, the providers and place of service, the hospital stay and claim boxes, and staff notes.
 for(const name of ['prior_authorization_number','current_illness_date','through_date','paper_only','rendering_npi','place_of_service','encounter_mode','referring_provider_name','referring_npi','supervising_provider_name','supervising_npi','hospitalization_from','hospitalization_to','claim_codes','additional_claim_info','business_office_note'])assert.match(visit,new RegExp(`name="cd_${name}"`),name);
 assert.ok(visit.indexOf('data-encounter-provider')<visit.indexOf('id="billing-charge-lines"'),'provider and place sit above the procedures');
 // Only what was filled in is sent; an untouched form sends no claim details at all.
 const els=(values,checked=false)=>({elements:new Proxy({},{get:(_,key)=>key==='cd_paper_only'?{checked}:String(key).startsWith('cd_')?{value:values[String(key).slice(3)]||''}:undefined})});
 assert.equal(ctx.encounterClaimDetailsValue(els({})),null,'nothing filled in, nothing sent');
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.encounterClaimDetailsValue(els({prior_authorization_number:' PA-SYN-1 ',place_of_service:'10',through_date:'2026-11-14'},true)))),{prior_authorization_number:'PA-SYN-1',place_of_service:'10',through_date:'2026-11-14',paper_only:true});
 assert.ok(!/<details[^>]*\bopen/.test(visit),'and start closed');
 const row=chargeLine(visit);
 assert.match(visit,/<table class="billing-table charge-table" id="billing-charge-lines"><caption class="sr-only">/,  'the lines are one table');
 // One row per procedure, in the order the form is filled in: the procedure, its modifiers, how
 // many, the diagnoses it was for, the amount, then remove. Nothing else holds a column of its own.
 assert.match(visit,/<thead><tr><th>Procedure<\/th><th>Modifiers<\/th><th>Units<\/th><th>Diagnoses<\/th><th>Amount<\/th><th><\/th><\/tr><\/thead>/,'one row per line, with the columns in the order they are filled in');
 assert.equal((row.match(/<td/g)||[]).length,6,'and the row itself has exactly those five cells plus the remove button');
 assert.ok(!row.includes('charge-cell-description')&&!row.includes('data-charge-line-total'),'no description column and no per-line total column to make the row wide');
 assert.ok(!row.includes('<details')||row.indexOf('<details')>row.indexOf('name="code"'),'the procedure code is outside any closed box');
 assert.match(row,/data-charge-diagnoses/,'the diagnosis chips stay on the line');
 assert.match(row,/name="diagnoses"/,'and the line still submits the same diagnoses field');
 assert.match(row,/class="charge-drug"/,'the drug fields sit inside the row, not behind a closed box');
 assert.ok(visit.indexOf(box)>visit.indexOf('data-add-charge'),'fees and notes come after the charge lines');
 const tucked=visit.slice(visit.indexOf('data-visit-charge-options'));
 assert.ok(['visit_id','service_date','coverage_id','notes','fee_facility','fee_setting'].every(name=>tucked.includes(`name="${name}"`)),'the encounter fields are still inside the form and still submitted');
 assert.match(visit,/<button type="button" data-add-charge>\+ Add another charge<\/button>/);
 assert.doesNotMatch(visit,/>Save charges<|>Cancel<|name="reason"/,'the table saves itself: no save button, no cancel, no reason box');
 assert.doesNotMatch(visit,/name="code_system"/,'no code system field anywhere on a charge line');
 assert.match(visit,/<button type="button" data-remove-charge>Remove<\/button>/,'each line has one plain Remove');
 assert.doesNotMatch(visit,/Remove line/);
 assert.match(visit,/>Amount</);assert.match(visit,/>Use practice price</);assert.match(visit,/<summary>Code list this came from<\/summary>/);
 assert.doesNotMatch(visit,/>Diagnoses for this service</,'the letters answer for the line; there is no free-text box to label');
 assert.ok(visit.indexOf('data-charge-line-totals')>visit.indexOf('</table>'),'the totals sit under the lines, not in a column beside them');
 assert.match(visit,/data-charge-total/,'the totals sit under the table and move as lines change');
 assert.doesNotMatch(visit,/Account notes|Line total \(USD\)|Reviewed ICD-10|Check approved fee|Catalog release options|Record each service once|Code system/,'no long or developer wording is shown in the encounter charge table');
 // Saving with a required field left empty inside the box opens it so the browser can show the problem.
 const broken={checkValidity:()=>false},ok={checkValidity:()=>true},fields=[ok,broken],tuckedBox={open:false,querySelectorAll:()=>fields};
 const chargeForm={id:'billing-account-form',querySelector:selector=>selector==='[data-visit-charge-options]'?tuckedBox:null};
 captureHandlers.submit({target:chargeForm});assert.equal(tuckedBox.open,true,'an empty required field inside the box opens it before the browser validates');
 tuckedBox.open=false;fields.length=0;fields.push(ok);
 captureHandlers.submit({target:chargeForm});assert.equal(tuckedBox.open,false,'a complete box stays closed when saving');
 // Opened from the Billing tab with no visit chosen, the form keeps its full layout.
 ctx.chartSection='billing';ctx.activeVisit=null;ctx.revenueServiceDate=()=>'';
 ctx.workspace.billing.coverages=[{id:'cov-p',content:{priority:'primary',payer_id:'payer-a',member_id:'SYN-1',status:'active',effective_date:'2026-01-01'}}];
 ctx.accountEditor();
 const flat=nodes['billing-editor'].innerHTML;
 assert.doesNotMatch(flat,/data-visit-charge-options|Visit, insurance and fee options/,'the Billing tab form is not shortened');
 assert.ok(flat.indexOf('name="visit_id"')<flat.indexOf('id="billing-charge-lines"'),'the encounter choice still sits above the lines');
 assert.match(flat,/<p class="muted">Enter the amount for the whole line, not for one unit\.<\/p>/);
 assert.match(flat,/<h4>Insurance on [^<]+<\/h4>/,'the Billing tab form still lists the insurance on file');
 assert.match(flat,/data-add-charge>\+ Charge line</);assert.match(flat,/<label>Notes<textarea name="notes"/);
 console.log('PASS live visit charge table: one table with the columns staff asked for, no save button or reason box, one closed options box holding the encounter fields, opened on save when a field inside is invalid, Billing tab layout unchanged');
})().catch(error=>{console.error(error);process.exitCode=1;});
