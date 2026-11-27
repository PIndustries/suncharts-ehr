// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}
const nodes={},captureHandlers={},ctx={console,Date,Intl,URL,URLSearchParams,crypto:{randomUUID:()=>'synthetic-request'},selected:'patient',me:{role:'owner'},chartSection:'billing',
 workspace:{appointments:[],visits:[{id:'visit-a',appointment_id:'appt-a',created_at:'2026-11-13T14:00:00Z'}],billing:{accounts:[],coverages:[],entries:[]}},
 // The charge form is held as text here, so the editor host never answers for the form itself.
 $:id=>id==='billing-account-form'?ctx.openedForm:(nodes[id]??={id,innerHTML:'',dataset:{},scrollIntoView(){},replaceChildren(){this.innerHTML='';},querySelector:()=>null,querySelectorAll:()=>[]}),
 document:{addEventListener:(name,fn,useCapture)=>{if(useCapture)captureHandlers[name]=fn;}},
 esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),human:v=>v,date:v=>String(v),money:n=>'$'+(n/100).toFixed(2),dollars:c=>c==null?'':(c/100).toFixed(2),payerName:()=>'Synthetic payer',billingCan:()=>true,
 notice(){},run:fn=>fn(),showChartSection(){},chartOpenEditor(){},setEncounterSection(){}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/billing.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/fees.js','utf8'),ctx);
// A row is read up to the diagnosis host that follows it, which is where its cells end.
const chargeLine=html=>{const start=html.indexOf('<tr class="billing-charge-row"');const end=html.indexOf('</tr>',start);return html.slice(start,end);};
(async()=>{
 ctx.revenueServiceDate=()=>'2026-11-13';
 ctx.api=async()=>({version:3,diagnoses:[]});
 // Opened from inside the encounter: the charge lines come first, everything else is tucked away.
 ctx.chartSection='visits';ctx.activeVisit={id:'visit-a',appointment_id:'appt-a',status:'in_progress'};
 ctx.accountEditor(null,null,true);
 const visit=nodes['encounter-billing-editor'].innerHTML;
 assert.match(visit,/<section class="charge-encounter-head" data-visit-charge-options><h4>Insurance and dates<\/h4>/,'insurance and the date of service have their own section');
 assert.ok(visit.indexOf('charge-lines-title">Procedures')<visit.indexOf('data-visit-charge-options'),'procedures come first, right under the diagnoses; insurance and dates follow');
 assert.doesNotMatch(visit,/data-check-codes|>Check codes</);
 assert.match(visit,/data-line-code-check role="status" hidden/,'every procedure has an inline place for automatic checks');
 assert.match(visit,/data-code-check role="status" hidden/,'cross-line findings stay with the procedures');
 assert.match(visit,/<details class="charge-more-options" data-inline><summary>Fees and notes<\/summary>/,'fees and notes are tucked under the procedures');
 // The encounter form carries the claim details a paper encounter form has: prior authorization,
 // dates, the providers and place of service, the hospital stay and claim boxes, and staff notes.
 for(const name of ['prior_authorization_number','current_illness_date','through_date','paper_only','rendering_npi','place_of_service','encounter_mode','referring_provider_name','referring_npi','supervising_provider_name','supervising_npi','hospitalization_from','hospitalization_to','claim_codes','additional_claim_info','business_office_note'])assert.match(visit,new RegExp(`name="cd_${name}"`),name);
 assert.ok(visit.indexOf('data-encounter-provider')>visit.indexOf('id="billing-charge-lines"'),'provider and place come after the procedures');
 // Only what was filled in is sent; an untouched form sends no claim details at all.
 const els=(values,checked=false)=>({elements:new Proxy({},{get:(_,key)=>key==='cd_paper_only'?{checked}:String(key).startsWith('cd_')?{value:values[String(key).slice(3)]||''}:undefined})});
 assert.equal(ctx.encounterClaimDetailsValue(els({})),null,'nothing filled in, nothing sent');
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.encounterClaimDetailsValue(els({prior_authorization_number:' PA-SYN-1 ',place_of_service:'10',through_date:'2026-11-14'},true)))),{prior_authorization_number:'PA-SYN-1',place_of_service:'10',through_date:'2026-11-14',paper_only:true});
 assert.ok(!/<details[^>]*\bopen/.test(visit),'and start closed');
 const row=chargeLine(visit);
 assert.match(visit,/<table class="billing-table charge-table charge-table-compact" id="billing-charge-lines"><caption class="sr-only">/, 'the lines are one table');
 // The first pass through the table exposes only the day-to-day procedure fields.
 const head=visit.slice(visit.indexOf('<thead>'),visit.indexOf('</thead>'));
 assert.deepEqual([...head.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(match=>match[1]),['Procedure','Units','Diagnoses','Amount']);
 assert.equal((row.match(/<td/g)||[]).length,5,'four coding cells plus the line actions');
 assert.match(row,/<details class="charge-line-options" data-inline data-charge-line-options><summary>Line options[^]*name="modifiers"/,'the existing modifier input sits in a closed line disclosure');
 assert.equal((row.match(/name="modifiers"/g)||[]).length,1,'the modifier UI has exactly one canonical field');
 assert.ok(!row.includes('charge-cell-description')&&!row.includes('data-charge-line-total'),'no description column and no per-line total column to make the row wide');
 assert.ok(!row.includes('<details')||row.indexOf('<details')>row.indexOf('name="code"'),'the procedure code is outside any closed box');
 assert.match(row,/data-charge-diagnoses/,'the diagnosis chips stay on the line');
 assert.match(row,/name="diagnoses"/,'and the line still submits the same diagnoses field');
 assert.match(row,/class="charge-drug"/,'the drug fields sit inside the row, not behind a closed box');
 const presets=visit.indexOf('data-encounter-code-presets'),setup=visit.indexOf('data-encounter-code-setup');
 assert.ok(presets>visit.indexOf('data-add-charge')&&setup>presets,'saved procedures and setup are below the coding fields');
 assert.match(visit,/<details class="charge-more-options" data-inline data-encounter-code-setup><summary>Billing setup and claim fields<\/summary>/,'billing setup starts closed');
 const tucked=visit.slice(visit.indexOf('data-visit-charge-options'));
 assert.ok(['visit_id','service_date','coverage_id','notes','fee_facility','fee_setting'].every(name=>tucked.includes(`name="${name}"`)),'the encounter fields are still inside the form and still submitted');
 assert.match(visit,/<button type="button" data-add-charge>\+ Add procedure<\/button>/);
 assert.doesNotMatch(visit,/>Save charges<|>Cancel<|name="reason"/,'the table saves itself: no save button, no cancel, no reason box');
 assert.doesNotMatch(visit,/name="code_system"/,'no code system field anywhere on a charge line');
 assert.match(visit,/<button type="button" data-remove-charge>Remove<\/button>/,'each line has one plain Remove');
 assert.doesNotMatch(visit,/Remove line/);
 assert.match(visit,/>Amount</);assert.match(visit,/>Use practice price</);assert.match(visit,/<summary>Code list this came from<\/summary>/);
 assert.doesNotMatch(visit,/>Diagnoses for this service</,'the letters answer for the line; there is no free-text box to label');
 assert.ok(visit.indexOf('data-charge-line-totals')>visit.indexOf('</table>'),'the totals sit under the lines, not in a column beside them');
 assert.match(visit,/data-charge-total/,'the totals sit under the table and move as lines change');
 assert.doesNotMatch(visit,/Account notes|Line total \(USD\)|Reviewed ICD-10|Check approved fee|Catalog release options|Record each service once|Code system/,'no long or developer wording is shown in the encounter charge table');
 // Run the same paint used by opening the editor, editing fields, and adding or removing rows.
 const host=()=>({hidden:true,innerHTML:''});
 const makeRow=(code,modifiers='')=>{
  const fields={code:{value:code},units:{value:'1'},diagnoses:{value:'M54.2'},ndc_code:{value:''},modifiers:{value:modifiers}};
  const feedback=host(),options={open:false};
  return {fields,feedback,options,querySelector:sel=>sel==='[data-line-code-check]'?feedback:sel==='[data-charge-line-options]'?options:fields[/name="([^"]+)"/.exec(sel)?.[1]],hasAttribute:()=>false};
 };
 const drug=makeRow('J0585'),office=makeRow('99213'),summary=host();
 let lines=[drug,office];
 const form={dataset:{},elements:{coverage_id:{value:'coverage'}},querySelector:sel=>sel==='[data-code-check]'?summary:sel==='#billing-charge-lines'?{querySelectorAll:()=>lines}:null};
 ctx.renderEncounterCodeChecks(form);
 assert.match(drug.feedback.innerHTML,/NDC/);assert.match(office.feedback.innerHTML,/modifier 25/);
 assert.equal(office.options.open,false,'optional modifier advice does not open the disclosure');
 const incorrectModifiers=makeRow('64642','50');
 lines=[incorrectModifiers];ctx.renderEncounterCodeChecks(form);
 assert.match(incorrectModifiers.feedback.innerHTML,/Do not use modifier 50/);
 assert.equal(incorrectModifiers.options.open,true,'a modifier that blocks the claim exposes its control');
 lines=[drug,office];
 drug.fields.ndc_code.value='00000000001';drug.fields.modifiers.value='JZ';office.fields.modifiers.value='25';
 ctx.renderEncounterCodeChecks(form);
 assert.ok(drug.feedback.hidden&&office.feedback.hidden&&summary.hidden);
 lines=[office,makeRow('99213','25')];ctx.renderEncounterCodeChecks(form);
 assert.match(lines[1].feedback.innerHTML,/Duplicate 99213/);
 lines=[office];ctx.renderEncounterCodeChecks(form);assert.ok(office.feedback.hidden);
 drug.fields.ndc_code.value='';form.elements.coverage_id.value='';lines=[drug];ctx.renderEncounterCodeChecks(form);
 assert.ok(drug.feedback.hidden,'payer checks clear when staff switch to self-pay');
 form.elements.coverage_id.value='coverage';ctx.renderEncounterCodeChecks(form);assert.match(drug.feedback.innerHTML,/NDC/);
 // Native form validation fires invalid before submit, including for CSS-hidden descendants.
 const fields=[],chargeForm={id:'billing-account-form',querySelectorAll:()=>fields};
 const setupDetails={tagName:'DETAILS',open:false,parentElement:chargeForm};
 const nestedDetails={tagName:'DETAILS',open:false,parentElement:setupDetails};
 const reason={form:chargeForm,parentElement:nestedDetails,validity:{valid:false},value:''};
 fields.push(reason);
 captureHandlers.invalid({target:reason});
 assert.equal(nestedDetails.open,true,'native validation reveals the invalid field');
 assert.equal(setupDetails.open,true,'every enclosing disclosure also opens');
 setupDetails.open=false;nestedDetails.open=false;reason.validity.valid=true;
 captureHandlers.submit({target:chargeForm});
 assert.equal(setupDetails.open,false,'valid fields leave the disclosures closed');
 const feeOverride={hidden:true,querySelector:()=>reason,closest:()=>nestedDetails};
 const feeLine={dataset:{feeSchedule:'schedule',feeExpected:'10000'},querySelector:()=>feeOverride};
 ctx.cents=text=>Math.round(Number(text)*100);
 ctx.amount={value:'80.00'};
 ctx.feeOverrideState({querySelector:selector=>selector==='[data-fee-line]'?feeLine:ctx.amount});
 assert.equal(reason.required,true,'a changed approved fee requires an override reason');
 assert.equal(feeOverride.hidden,false);
 assert.equal(nestedDetails.open,true,'the reason is immediately visible when it becomes required');
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
 console.log('PASS visit coding shows the usual fields, reveals actionable errors, and retains the full Billing tab editor');
})().catch(error=>{console.error(error);process.exitCode=1;});
