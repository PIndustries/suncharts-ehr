// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// The "Review and post charges" block offers one button per action instead of an "Action"
// picker plus a generic Confirm. Staff only have to read the button they press.
const nodes={},handlers={},sent=[];
const node=id=>nodes[id]??={id,innerHTML:'',dataset:{},open:false,scrollIntoView(){},replaceChildren(){this.innerHTML='';}};
const account={id:'account',status:'draft',version:4,total_cents:20000,content:{visit_id:'visit',coverage_id:'coverage',service_date:'2026-11-11',lines:[],notes:''}};
const ctx={console,Date,Intl,URL,URLSearchParams,Map,Set,Array,Math,Number,String,JSON,encodeURIComponent,crypto:{randomUUID:()=>'request'},
 me:{role:'owner'},selected:'patient',billingSelected:'account',chartSection:'visits',encounterSection:'charges',
 activeVisit:{id:'visit',appointment_id:'appt',status:'signed'},
 workspace:{appointments:[{id:'appt',starts_at:'2026-11-11T14:00:00Z',status:'in_progress'}],visits:[{id:'visit',appointment_id:'appt',status:'signed'}],billing:{accounts:[account],coverages:[],entries:[],copays:[]}},
 $:node,document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},
 esc:v=>String(v??''),human:String,date:String,money:v=>'$'+(v/100).toFixed(2),payerName:()=>'Synthetic Medicare PPO',
 billingCan:()=>true,showChartSection(){},setEncounterSection(){},showEncounterSection(){},notice(){},
 selectPatient:async()=>{sent.push(['rerender']);},run:fn=>{ctx.pending=Promise.resolve().then(fn);return ctx.pending;},
 visitBillingDate:v=>String(v),billingDetailHost:()=>node('billing-detail'),billingEditorHost:()=>node('encounter-billing-editor'),
 chargeTable:()=>'',billingChargeDraftRecovery:()=>'',accountDiagnosisSummary:()=>'',accountDiagnosisDraftRecovery:()=>'',
 api:async(...args)=>{sent.push(args);return account;}};
vm.createContext(ctx);
const source=fs.readFileSync('web/billing.js','utf8');
vm.runInContext(source.slice(source.indexOf('function encounterRevenueVisitUnsigned('),source.indexOf('function coveragePayerOptions(')),ctx);
vm.runInContext(`const billingBase=()=>\`/api/v1/patients/\${selected}/billing/accounts\`;const entrySum=()=>0,billBalance=()=>20000,billingPayers=[],billingField=(name,label)=>\`<label>\${label}<input name="\${name}" required></label>\`;`,ctx);
vm.runInContext(source.slice(source.indexOf("document.addEventListener('submit'"),source.indexOf('const accountDiagnosisLinkDrafts')),ctx);
const formHtml=()=>{const html=node('encounter-billing-detail').innerHTML;return html.slice(html.indexOf('<form id="billing-account-action"'));};
// FormData only ever reads the fields the pressed button and the reason box carry.
function submit(fields){ctx.FormData=class{constructor(){const entries=Object.entries(fields);this[Symbol.iterator]=entries[Symbol.iterator].bind(entries);}};const form={id:'billing-account-action',dataset:{account:'account',version:'4'},elements:{},querySelectorAll:()=>[]};for(const handler of handlers.submit)handler({target:form,preventDefault(){}});return ctx.pending;}
const lastAction=()=>sent.filter(call=>call[0]!=='rerender').at(-1);
const actionBody=()=>JSON.parse(JSON.stringify(lastAction()[2]));
(async()=>{
 ctx.showBillingAccount('account',false);let html=formHtml();
 assert.match(html,/<h3>Review and post charges<\/h3>/);
 assert.doesNotMatch(html,/<select|>Confirm</,'no action picker and no generic Confirm left');
 assert.match(html,/Posting makes the charges final and prepares the insurance claim for you to review\. The visit note must be signed first\./,'the helper sentence stays');
 assert.match(html,/<button type="submit" class="primary" name="action" value="post">Post charges<\/button><button type="submit" name="action" value="void">Remove these charges<\/button>/,'each action is its own button');
 // The same block on the billing page's own account view keeps its own wording.
 ctx.chartSection='billing';ctx.showBillingAccount('account',false);html=node('billing-detail').innerHTML;
 assert.match(html,/<h3>Review and post charges<\/h3>[\s\S]*Posting locks the charges\. The visit note must be signed first\./);
 assert.doesNotMatch(html,/<select|>Confirm</);
 assert.match(html,/<button type="submit" class="primary" name="action" value="post">Post charges<\/button><button type="submit" name="action" value="void">Void draft<\/button>/);
 ctx.chartSection='visits';
 // Posting sends exactly what choosing "Post charges" and pressing Confirm used to send.
 await submit({action:'post',reason:'Charges reviewed with the clinician'});
 assert.equal(lastAction()[0],`/api/v1/patients/patient/billing/accounts/account/actions`);assert.equal(lastAction()[1],'POST');assert.equal(lastAction()[3],4);
 assert.deepEqual(actionBody(),{action:'post',reason:'Charges reviewed with the clinician',local_only:false});
 // Removing the wrong charges is the plain button beside it.
 await submit({action:'void',reason:'Recorded for the wrong visit'});
 assert.deepEqual(actionBody(),{action:'void',reason:'Recorded for the wrong visit',local_only:false});
 // The local-only acknowledgement still travels with posting when the payer has no electronic ID.
 await submit({action:'post',reason:'Bill this visit outside SunCharts',local_only:'true'});
 assert.equal(actionBody().local_only,true);
 // An unsigned visit note blocks posting only; the helper sentence stays visible.
 ctx.workspace.visits=[{id:'visit',appointment_id:'appt',status:'in_progress'}];ctx.activeVisit={...ctx.activeVisit,status:'in_progress'};
 ctx.showBillingAccount('account',false);html=formHtml();
 assert.match(html,/The visit note must be signed first/);
 assert.match(html,/<button type="submit" class="primary" name="action" value="post" disabled>Post charges<\/button>/,'posting waits for the signed note');
 assert.match(html,/<button type="submit" name="action" value="void">Remove these charges<\/button>/,'removing wrong charges stays available');
 console.log('PASS charge actions as named buttons: exact post/void bodies, local-only acknowledgement, unsigned note blocks posting only');
})().catch(error=>{console.error(error);process.exitCode=1;});
