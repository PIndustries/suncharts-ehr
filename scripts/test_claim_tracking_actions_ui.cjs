// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

function fixture(){
 const handlers={},timers=new Map(),calls=[],notices=[];let sequence=0,response;
 const nodes={draft:{value:'Unsaved claim details',disabled:false}};
 // The claim page as drawn: one piece of markup holding the next step, the status word and the
 // version, with the progress panel as a node inside it. A status refresh rewrites the page in place,
 // so the test holds the markup the same way the real host does.
 // The claim page exactly as showClaim draws it: the head with its status word and version, the one
 // next step, the service lines, and More details holding the panels. The next step is a <section>,
 // which is what a status refresh has to replace in place.
 const page='<section class="billing-account-detail">'
  +'<div class="section-head claim-screen-head"><div><h2>Claim review</h2>'
  +'<small class="claim-control" data-claim-current-version>SYN-CLAIM · v1</small></div>'
  +'<span class="status-badge claim-status-word" data-claim-current-status>Not sent yet</span></div>'
  +'<section class="claim-primary" data-claim-primary aria-label="Next step"><div class="claim-primary-action"><p>This claim is being prepared.</p></div></section>'
  +'<div class="claim-lines" data-claim-lines><p>Three charge lines.</p></div>'
  +'<details class="claim-more" data-claim-more-details><summary>More details</summary></details>'
  +'</section>';
 const host={innerHTML:page,
  // The progress panel is a node inside the page and is replaced as a whole, so the test reads it
  // back out of the markup the way a person reads the screen.
  querySelector(s){if(s!=='.claim-lifecycle')return null;const host_=this;return{
   get outerHTML(){const m=/<section class="claim-lifecycle"[\s\S]*?<\/section>/.exec(host_.innerHTML);return (m?m[0]:'')+(this._error||'');},
   // The panel sits inside More details, so it is written into there rather than onto the outer page.
   set outerHTML(html){host_.innerHTML=host_.innerHTML.includes('claim-lifecycle')
    ?host_.innerHTML.replace(/<section class="claim-lifecycle"[\s\S]*?<\/section>/,html)
    :host_.innerHTML.replace('<summary>More details</summary>',`<summary>More details</summary>${html}`);},
   querySelector:()=>null,set _ignored(v){},insertAdjacentHTML(_where,html){this._error=(this._error||'')+html;}};}};
 // Whatever the person had typed into the claim form before the poll, kept where the page holds it.
 nodes.panel=null;
 const claim={id:'claim',patient_id:'patient',account_id:'account',version:1,status:'ready',control_number:'SYN-CLAIM',snapshot:{account:{coverage_snapshot:{}}}};
 const context=vm.createContext({console,Map,WeakMap,JSON,Date,Error,Array,Object,Boolean,Number,String,RegExp,Math,isNaN,parseInt,parseFloat,WeakSet,document:{addEventListener:(name,fn)=>(handlers[name]??=[]).push(fn)},$:id=>id==='encounter-claims-detail'?host:null,me:{role:'clinician'},selected:'patient',activeVisit:{id:'visit'},chartSection:'visits',encounterSection:'charges',workspace:{billing:{accounts:[{id:'account',content:{visit_id:'visit'}}]}},esc:v=>String(v??''),human:String,date:String,billingWrite:()=>true,notice:message=>notices.push(message),run:fn=>context.pending=fn(),api:async path=>{calls.push(path);return typeof response==='function'?response(path):response;},setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(fs.readFileSync('web/claims.js','utf8'),context);vm.runInContext(fs.readFileSync('web/claimmd-native.js','utf8'),context);context.fixtureClaim=claim;
 vm.runInContext("claimCurrent=fixtureClaim;claimViewContext={kind:'encounter',identity:me,patient:selected,visit:'visit',account:'account',host:$('encounter-claims-detail')};claimMdConnectionState={connected:true,active:{id:'setting'}}",context);
 return {context,nodes,host,claim,handlers,timers,calls,notices,setResponse:value=>response=value,
  // Runs the next status poll and hands back what the page now shows. The next step, the status word
  // and the progress panel are separate nodes on the claim page, so the screen is read as a whole.
  async poll(){const fn=[...timers.values()][0];timers.clear();await fn();return host.innerHTML;},async click(){const b={dataset:{claimmdSubmit:'claim'}};const event={target:{closest:s=>s==='[data-claimmd-submit]'?b:null},preventDefault(){}};for(const h of handlers.click)h(event);await context.pending;}};
}
(async()=>{
 for(const status of ['submitted','rejected']){
  const f=fixture();f.setResponse({claim:{...f.claim,status,version:2},tracking:{}});f.context.startClaimMdTracking('claim');const screen=await f.poll();assert.match(screen,new RegExp('claim-current-status>'+f.context.claimPlainStatus({...f.claim,status}),''),'the one status word follows the answer that came back');assert.match(screen,/SYN-CLAIM · v2/,'the claim version shown is the one that came back');assert.doesNotMatch(screen,/data-claimmd-submit/,'a claim already sent is not offered for sending again');assert.match(screen,new RegExp(status));assert.equal(f.nodes.draft.value,'Unsaved claim details');assert.equal(f.nodes.draft.disabled,false);assert.equal(f.calls.length,1);assert.equal(f.timers.size,1);
 }
 // A claim the clearinghouse has already received must not offer "Send claim" again, whether the
 // delivery came back from the clearinghouse or was recorded by hand outside SunCharts.
 for(const tracking of [{submissions:[{status:'delivered'}]},{external_submission_recorded:true}]){
  const f=fixture();f.setResponse({claim:f.claim,tracking});f.context.startClaimMdTracking('claim');const screen=await f.poll();
  assert.doesNotMatch(screen,/data-claimmd-submit/,'a claim the clearinghouse has received is not offered for sending again');
  assert.match(screen,/This claim has been sent/,'the one next step says the claim is already out');
  assert.match(screen,/>Sent</,'and the status word agrees with it');
 }
 // A file that is only prepared is not proof anything reached the insurer, so the claim is not
 // called sent and a prepared file is not left invisible.
 {const f=fixture();f.setResponse({claim:f.claim,tracking:{submissions:[{id:'submission',status:'prepared'}]}});f.context.startClaimMdTracking('claim');const screen=await f.poll();
  assert.doesNotMatch(screen,/This claim has been sent/,'a prepared file is not a sent claim');
  assert.match(screen,/prepared but not confirmed/,'the gap between prepared and received is named');
  assert.match(screen,/data-claim-existing-submission="submission"/,'the file already prepared is the thing to open');}
 for(const mutate of [f=>f.context.selected='another',f=>f.context.activeVisit={id:'another'},f=>f.context.me={role:'clinician'}]){
  const f=fixture();let finish;f.setResponse(()=>new Promise(resolve=>finish=resolve));f.context.startClaimMdTracking('claim');const pending=f.poll();mutate(f);finish({claim:{...f.claim,status:'submitted',version:2}});await pending;assert.match(f.host.innerHTML,/>Not sent yet</,'a stale answer does not overwrite the claim on screen');assert.doesNotMatch(f.host.innerHTML,/SYN-CLAIM · v2/);assert.equal(f.timers.size,0);
 }
 const mismatch=fixture();mismatch.setResponse({claim:{...mismatch.claim,id:'wrong'}});mismatch.context.startClaimMdTracking('claim');await mismatch.poll();assert.doesNotMatch(mismatch.host.innerHTML,/SYN-CLAIM · v2/,'an answer about another claim is not drawn here');assert.doesNotMatch(mismatch.host.innerHTML,/>Sent</,'nor is its status word');
 for(const detail of [{status:'submitted'}, {status:'rejected'}, {status:'ready',tracking:{submissions:[{status:'delivered'}]}}, {status:'ready',tracking:{submissions:[{status:'prepared'}]}}]){
  const f=fixture();let rendered=0,refreshed=0;f.context.claimMdSubmitEditor=()=>rendered++;f.context.showClaim=async id=>{assert.equal(id,'claim');refreshed++;};f.setResponse({claim:{...f.claim,status:detail.status},tracking:detail.tracking});await f.click();assert.equal(rendered,0);assert.equal(refreshed,1);assert.match(f.notices[0],/may already have been sent/);assert.equal(f.calls.length,1);
 }
 const ready=fixture();let rendered=0;ready.context.claimMdSubmitEditor=()=>rendered++;ready.setResponse({claim:ready.claim,tracking:{submissions:[{status:'cancelled'}]}});await ready.click();assert.equal(rendered,1,'cancelled artifacts do not block a fresh explicit review');
 const late=fixture();let finish;late.setResponse(()=>new Promise(resolve=>finish=resolve));late.context.claimMdSubmitEditor=()=>{throw new Error('Cannot publish stale editor');};const pending=late.click();late.context.selected='another';finish({claim:late.claim});await pending;
 const bridge=fixture(),order=[];let deliveredGuard;bridge.context.captureClaimDraft=()=>order.push('capture');bridge.context.showEdiWorkspace=async(_after,guard)=>{assert.equal(guard(),true);order.push('workspace');return true;};bridge.context.showEdiSubmission=async(id,guard)=>{order.push('submission:'+id);deliveredGuard=guard;};
 const existingButton={type:'button',dataset:{claimExistingSubmission:'submission'},hasAttribute:()=>false,closest:selector=>selector==='#encounter-claims'?{}:null};for(const handler of bridge.handlers.click)handler({target:{closest:selector=>selector==='button'?existingButton:null},preventDefault(){}});await bridge.context.pending;assert.deepEqual(order,['capture','workspace','submission:submission']);assert.equal(deliveredGuard({submission:{id:'submission',claim_id:'claim'},claim:bridge.claim}),true);assert.throws(()=>deliveredGuard({submission:{id:'submission',claim_id:'other'},claim:bridge.claim}),/does not belong/);bridge.context.selected='other';assert.equal(deliveredGuard({submission:{id:'submission',claim_id:'claim'},claim:bridge.claim}),false);
 const oldBridge=fixture();oldBridge.context.captureClaimDraft=()=>{};oldBridge.context.showEdiWorkspace=async()=>{oldBridge.context.me={role:'clinician'};};oldBridge.context.showEdiSubmission=()=>{throw new Error('Old identity cannot open submission');};await oldBridge.context.reviewExistingClaimSubmission('submission');
 console.log('PASS polling updates the one next step/status/version while preserving form contents, rejects mismatched/stale evidence, and fresh review prevents resubmission after status or delivery changes');
})().catch(error=>{console.error(error);process.exitCode=1;});
