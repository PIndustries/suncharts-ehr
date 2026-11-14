// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync('web/app.js','utf8'),previsit=fs.readFileSync('web/previsit.js','utf8'),css=fs.readFileSync('web/style.css','utf8');
const extract=(source,start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);};
const escape=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function fixture(){
 const nodes={'tools':{hidden:false,firstElementChild:{},replaceChildren(){this.firstElementChild=null;}},'clinical-workspace':{hidden:true},'new-patient':{hidden:true},'toggle-directory':{hidden:true},'patient-intake-panel':{innerHTML:'',isConnected:true,focus(){this.focused=true;},scrollIntoView(){}},'patient-intake-summary':{textContent:''}},handlers={},calls=[];
 const ctx={console,Map,Set,encodeURIComponent,me:{tenant_id:'tenant',user_id:'staff',role:'owner'},selected:'patient-one',workspace:{demographics:{content:{phone:'+1 555 010 2026',email:'synthetic@example.test'}}},workspaceResourceAllowed:()=>true,chartAreaEnabled:()=>true,esc:escape,date:String,human:v=>String(v).replaceAll('_',' '),$:id=>nodes[id],document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn)},captureVisitDrafts:()=>calls.push(['capture']),openWorkflowIntakePacket:async id=>calls.push(['packet',id]),selectPatient:async id=>{ctx.selected=id;calls.push(['patient',id]);},showChartSection:s=>calls.push(['section',s]),showTool:()=>{nodes['tools'].hidden=false;nodes['clinical-workspace'].hidden=true;},canRegisterPatient:()=>true,run:fn=>ctx.pending=fn()};
 const item={packet_id:'packet-one',status:'submitted',template_name:'Retained intake',starts_at:'2025-01-01',appointment_title:'Historical completed appointment',appointment_status:'completed',submitted_at:'2025-01-01',has_response:true};
 ctx.api=async(path,method='GET')=>{calls.push([path,method]);return {patient_id:ctx.selected,items:[item],summary:{total:1,submitted:1,reviewed:0},next_cursor:null};};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),ctx);vm.runInContext(extract(app,'function chartContactSummary(){','function chartOverview(){'),ctx);vm.runInContext(extract(previsit,'// Patient history includes','function installPrevisitNavigation(){'),ctx);vm.runInContext(extract(previsit,"document.addEventListener('click',event=>{const button=event.target.closest?.('#nav-previsit","document.addEventListener('submit',event=>{const form=event.target;if(!['previsit-settings"),ctx);
 return {ctx,nodes,handlers,calls,item};
}
(async()=>{
 let f=fixture(),c=f.ctx;
 let html=c.chartContactSummary();assert.match(html,/Phone.*\+1 555 010 2026/s);assert.match(html,/Email.*synthetic@example.test/s);assert.match(html,/data-chart-section="profile"/);assert.match(html,/data-patient-intakes-open/);
 c.workspace.demographics.content={phone:'<img src=x>',email:'<script>private</script>'};html=c.chartContactSummary();assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;script&gt;/);
 c.workspace.demographics={content:{}};assert.equal((c.chartContactSummary().match(/Not recorded/g)||[]).length,2);
 c.workspaceResourceAllowed=()=>false;assert.equal(c.chartContactSummary(),'');await c.renderPatientIntakePackets();assert.equal(f.calls.length,0,'billing-only policy does not issue clinical intake reads');
 f=fixture();c=f.ctx;await c.renderPatientIntakePackets();html=f.nodes['patient-intake-panel'].innerHTML;
 assert.match(html,/Historical completed appointment · completed/);assert.match(html,/2025-01-01/);assert.match(html,/data-patient-intake-packet="packet-one">Review answers/);assert.match(html,/Filled in – needs review/);assert.match(html,/separate from uploaded files/);assert.match(f.nodes['patient-intake-summary'].textContent,/1 intake form · 1 submitted/);
 await c.openPatientIntakePacket('packet-one');assert.deepEqual(f.calls.slice(-2),[['capture'],['packet','packet-one']]);assert.ok(f.calls.every(call=>call[1]!=='POST'),'opening retained answers never reviews or promotes them');
 f.handlers.click[1]({target:{closest:()=>({dataset:{},hasAttribute:key=>key==='data-previsit-back'})},preventDefault(){},stopImmediatePropagation(){}});await c.pending;assert.equal(f.nodes['clinical-workspace'].hidden,false,'Back must reveal the native chart, not merely redraw it behind the intake tool');assert.equal(f.nodes.tools.hidden,true);assert.deepEqual(f.calls.slice(-2),[['patient','patient-one'],['section','documents']]);
 const evt={target:{closest:()=>({dataset:{},hasAttribute:key=>key==='data-patient-intakes-open'})},preventDefault(){},stopImmediatePropagation(){}};f.handlers.click[0](evt);assert.equal(f.nodes['patient-intake-panel'].focused,true);
 const menu={open:true,querySelector:()=>({focus:()=>menu.focused=true})};f.handlers.keydown[0]({key:'Escape',target:{closest:()=>menu},preventDefault(){}});assert.equal(menu.open,false);assert.equal(menu.focused,true);
 // Late same-host reads, replacement patient/session and replaced chart DOM cannot publish prior forms.
 for(const change of ['newer','patient','identity','host']){
  f=fixture();c=f.ctx;let finish;c.api=()=>new Promise(resolve=>finish=resolve);const slow=c.renderPatientIntakePackets();
  if(change==='newer'){c.api=async()=>({patient_id:'patient-one',items:[],summary:{total:0,submitted:0,reviewed:0}});await c.renderPatientIntakePackets();}
  if(change==='patient')c.selected='patient-two';if(change==='identity')c.me={...c.me};if(change==='host')f.nodes['patient-intake-panel']={innerHTML:'Replacement',isConnected:true};
  finish({patient_id:'patient-one',items:[f.item],summary:{total:1,submitted:1,reviewed:0}});await slow;
  assert.doesNotMatch(f.nodes['patient-intake-panel'].innerHTML,/Retained intake/,'stale '+change+' response');
 }
 f=fixture();c=f.ctx;c.api=async()=>{throw Error('Unavailable');};await c.renderPatientIntakePackets();assert.match(f.nodes['patient-intake-panel'].innerHTML,/Form count is unavailable, not zero/);assert.match(f.nodes['patient-intake-summary'].textContent,/unavailable/);
 // Pagination retains earlier forms, and uses only the returned patient-specific cursor.
 f=fixture();c=f.ctx;c.api=async path=>{f.calls.push([path,'GET']);return {patient_id:'patient-one',items:[{...f.item,packet_id:path.includes('?')?'older':'newer'}],summary:{total:2,submitted:2,reviewed:0},next_cursor:path.includes('?')?null:'newer'};};await c.renderPatientIntakePackets();await c.renderPatientIntakePackets(true);assert.match(f.calls[1][0],/intake-packets\?after=newer$/);assert.match(f.nodes['patient-intake-panel'].innerHTML,/data-patient-intake-packet="newer"/);assert.match(f.nodes['patient-intake-panel'].innerHTML,/data-patient-intake-packet="older"/);
 assert.match(app,/documents:\['documents-panel','patient-intake-panel'\]/);assert.match(app,/Contact &amp; demographics|Contact & demographics/);
 assert.ok(css.lastIndexOf('.chart-context{overflow:visible}')>css.indexOf('overflow:hidden'),'final header override lets the dropdown extend beyond its ancestor');assert.match(css,/\.patient-record-navigation>div\{max-height:min\(65vh,500px\);overflow-y:auto/);assert.match(css,/\.patient-record-navigation>div\{position:static/,'narrow viewports expand the menu in flow');
 console.log('PASS patient contacts/intake: direct escaped contact summary; retained old completed forms; clinical-only reads; patient/session/host/read-order isolation; safe detail/back; cursor pagination; unclipped keyboard menu');
})().catch(error=>{console.error(error);process.exitCode=1;});
