// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('web/app.js','utf8'),specialty=fs.readFileSync('web/specialty-workspace.js','utf8');
const nodes=Object.fromEntries(['chart-overview','functional-status-panel','specialty-care-panel','encounter-progress','practice-admin-panel'].map(id=>[id,{id,hidden:true,innerHTML:''}])),notices=[],calls=[];
let captured=0;
const context=vm.createContext({
 console,Map,Set,Array,Object,Number,Date,
 document:{addEventListener(){},querySelectorAll:()=>[]},$:id=>nodes[id]||null,
 me:{role:'owner'},chartSection:'overview',practiceAdminKinds:[],
 esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),
 notice:(...args)=>notices.push(args),capturePrescribingDraft:()=>captured++,
 FormData:class{constructor(form){this.values=form.values;}get(key){return this.values[key]??null;}},
 api:async(path,method,body,version)=>{calls.push({path,method,body,version});return {version:version+1,content:structuredClone(body.content)};},
});
vm.runInContext(specialty,context,{filename:'specialty-workspace.js'});
const start=app.indexOf('function applyChartSection(){'),end=app.indexOf('\nconst formData=',start);
assert.ok(start>=0&&end>start,'chart navigation functions remain available');
vm.runInContext(app.slice(start,end),context,{filename:'chart-navigation.js'});
const evaluate=source=>vm.runInContext(source,context),plain=value=>JSON.parse(JSON.stringify(value));

async function main(){
 evaluate(`workspace={appointments:[{id:'appt-1',status:'booked'}],billing:{accounts:[]}};activeVisit=null;patientClaimAccounts=()=>[];patientPaymentAccounts=()=>[];billingCan=()=>true`);
 let actions=evaluate('patientWorkflowActions()');
 assert.match(actions,/Check in to create encounter/);
 assert.match(actions,/data-patient-create-claim disabled>Create insurance claim/);
 assert.match(actions,/data-patient-collect-copay disabled>Collect copay \/ payment/);
 evaluate(`workspace.appointments[0].status='checked_in'`);actions=evaluate('patientWorkflowActions()');
 assert.match(actions,/data-start="appt-1">Create encounter/,'checked-in patients get a direct encounter action');

 const order=['billing','functional_status','profile','specialty_care','overview','visits','clinical','documents'];
 evaluate(`practiceWorkspaceSettings={version:4,content:{module_order:Object.keys(workspaceModuleIds),hidden_modules:['specialty'],chart_tabs:${JSON.stringify(order)}}}`);
 const html=evaluate('chartNavigation(configuredChartTabs(Object.entries(chartTabLabels)))');
 const primaryHtml=html.match(/chart-primary-tabs">([\s\S]*?)<\/div>/)?.[1]||'',secondaryHtml=html.match(/chart-workflow-tabs"[^>]*>([\s\S]*?)<\/div>/)?.[1]||'';
 const primary=[...primaryHtml.matchAll(/data-chart-section="([^"]+)"/g)].map(match=>match[1]),secondary=[...secondaryHtml.matchAll(/data-chart-section="([^"]+)"/g)].map(match=>match[1]);
 assert.deepEqual(primary,['functional_status','profile','specialty_care','overview','clinical','documents'],'configured clinical areas remain visible in the first chart row');
 assert.deepEqual(secondary,['billing','visits'],'configured core workflow areas remain visible in the second chart row');
 assert.equal(html.includes('chart-more-sections'),false,'patient chart navigation has no More dropdown');
 assert.deepEqual([...primary,...secondary].sort(),[...order].sort());

 // Editing visibility in the legacy administration form preserves Studio ordering.
 const selected=['billing','functional_status','specialty_care','overview','visits','clinical','documents','source'];
 const values={reason:'Synthetic chart visibility change'};
 for(const key of selected)values[`tab_${key}`]='on';
 const modules=plain(evaluate('Object.keys(workspaceModuleIds)'));
 modules.forEach((key,index)=>{values[`order_${key}`]=index+1;if(key!=='specialty')values[`visible_${key}`]='on';});
 context.form={dataset:{version:'4'},values};
 await evaluate('saveWorkspaceSettings(form)');
 assert.deepEqual(plain(calls.at(-1).body.content.chart_tabs),selected,'unselected areas are removed and newly enabled areas are appended');
 assert.deepEqual(plain(evaluate('practiceWorkspaceSettings.content.chart_tabs')),selected);

 // A worklist/workflow shortcut cannot open a disabled specialty area.
 evaluate("practiceWorkspaceSettings.content.chart_tabs=['overview','functional_status'];chartSection='overview';applyChartSection()");
 const beforeCapture=captured;
 evaluate("showChartSection('specialty_care')");
 assert.equal(evaluate('chartSection'),'overview');
 assert.equal(nodes['specialty-care-panel'].hidden,true);
 assert.equal(captured,beforeCapture,'blocked navigation does not disturb chart drafts');
 assert.deepEqual(notices.at(-1),['This chart area is hidden in the practice workspace.',true]);
 evaluate("showChartSection('functional_status')");
 assert.equal(evaluate('chartSection'),'functional_status');
 assert.equal(nodes['functional-status-panel'].hidden,false,'the independently enabled area opens even with specialty navigation hidden');
 assert.equal(nodes['specialty-care-panel'].hidden,true);

 // A later renderer must not reveal a section disabled while its read was pending.
 evaluate("practiceWorkspaceSettings.content.chart_tabs=['overview','specialty_care'];applyChartSection()");
 assert.equal(evaluate('chartSection'),'overview');
 assert.equal(nodes['functional-status-panel'].hidden,true);
 assert.equal(nodes['chart-overview'].hidden,false);
 evaluate("showChartSection('functional_status')");
 assert.equal(evaluate('chartSection'),'overview');
 evaluate("showChartSection('specialty_care')");
 assert.equal(evaluate('chartSection'),'specialty_care');
 assert.equal(nodes['specialty-care-panel'].hidden,false);
 evaluate("practiceWorkspaceSettings.content.chart_tabs=['overview'];chartSection='specialty_care';applyChartSection()");
 assert.equal(nodes['specialty-care-panel'].hidden,true,'direct or delayed render paths honor saved visibility');

 // Presentation controls do not replace the existing resource permission gate.
 evaluate("practiceWorkspaceSettings.content.chart_tabs=['overview','specialty_care'];practiceAccessPolicy={restricted:true,permissions:{clinical:{view:false}}};showChartSection('specialty_care')");
 assert.equal(evaluate('chartSection'),'overview');
 assert.equal(nodes['specialty-care-panel'].hidden,true);
 assert.deepEqual(notices.at(-1),['Your role does not have access to this chart area.',true]);
 console.log('PASS visible two-row chart navigation, administration save order, independent specialty navigation and disabled-area render guards');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
