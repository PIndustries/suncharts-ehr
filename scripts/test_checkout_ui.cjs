// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic DOM fixtures; real browser acceptance is a separate check.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const root=path.resolve(__dirname,'..');
function fixture(){
 const nodes=new Map(),events=new Map(),pending=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',dataset:{},hidden:false,addEventListener(){},setAttribute(){},removeAttribute(){},focus(){},scrollIntoView(){},classList:{contains(){return false;},remove(){}},replaceChildren(){},remove(){nodes.delete(id);}});return nodes.get(id);};
 const context=vm.createContext({console,Date,Intl,URLSearchParams,TextEncoder,location:{search:''},window:{addEventListener(){},scrollTo(){}},crypto:{randomUUID:()=> 'request-1'},document:{getElementById:node,querySelectorAll:()=>[],addEventListener(type,callback,options){if(!events.has(type))events.set(type,[]);events.get(type).push({callback,options});}},FormData:class{constructor(f){this.form=f;}*[Symbol.iterator](){yield*Object.entries(this.form.values||{});}},calls:[],pending});
 const run=s=>vm.runInContext(s,context);
 run(fs.readFileSync(path.join(root,'web/app.js'),'utf8'));run(fs.readFileSync(path.join(root,'web/checkout.js'),'utf8'));
 run(`human=s=>String(s||'').replaceAll('_',' ');localTime=s=>new Date(s).toISOString().slice(0,16);me={role:'owner',user_id:'clinician-1'};selected='patient-1';activeVisit={id:'visit-1',clinician_id:'clinician-1',status:'signed'};checkoutContext={patient:'patient-1',visit:'visit-1',key:'patient-1:visit-1'};checkoutState={version:0,visit:activeVisit,preview_digest:'digest-v1',preview_snapshot:{patient:{given_name:'Synthetic',family_name:'Patient',mrn:'SYN-1',birth_date:'1990-01-01'},medications:[],orders:[]},current_avs:null,releases:[],events:[],followups:[],checkout:{completed:false}};`);
 return {run,node,context,events,pending};
}
 async function main(){
 let f=fixture();f.run('renderVisitCheckoutContent()');
 let html=f.node('visit-checkout').innerHTML;
 assert.match(html,/data-version="0" data-digest="digest-v1"/);
 // One button releases the summary and checks the encounter out; no acknowledgement checkbox.
 assert.match(html,/<button type="submit" class="primary">Release visit summary<\/button>/);
 assert.doesNotMatch(html,/I reviewed the patient instructions|name="reviewed"|Release after-visit summary/);
 assert.match(html,/data-checkout-discard>Discard instruction edits</);
 assert.match(html,/<h2>Visit summary and follow-up<\/h2>/);
 assert.doesNotMatch(html,/id="avs-delivery-form"|id="checkout-complete-form"/);
 // Payment is collected in the encounter's payment block, never duplicated inside checkout.
 assert.doesNotMatch(html,/Account payment links|Separate from appointment copay|Create test payment link|Payment account|renderAccountPaymentPanel/);
 assert.doesNotMatch(html,/Charges &amp; payments|Open Charges & billing|No charges yet/);
 // Follow-up tasks and patient instructions stay on the screen.
 assert.match(html,/Follow-up tasks/);assert.match(html,/name="instructions"/);
 console.log('PASS one release-and-checkout button, no acknowledgement, no duplicated charges or payment links');
 f.run(`checkoutState.visit={...activeVisit,status:'in_progress'};renderVisitCheckoutContent()`);
 assert.match(f.node('visit-checkout').innerHTML,/Sign the note before/);assert.doesNotMatch(f.node('visit-checkout').innerHTML,/id="avs-release-form"/);
 for(const role of ['front_desk','read_only']){f.run(`me.role=${JSON.stringify(role)};checkoutState.visit=activeVisit;renderVisitCheckoutContent()`);assert.doesNotMatch(f.node('visit-checkout').innerHTML,/id="avs-release-form"/);}
 console.log('PASS unsigned visits and role-protected AVS release');
 f=fixture();f.run(`checkoutState.current_avs={version:2,content:{instructions:'<script>unsafe()</script>',follow_up_instructions:'Call <clinic>'},snapshot:checkoutState.preview_snapshot,released_at:'2026-10-25T12:00:00Z'};checkoutState.releases=[checkoutState.current_avs];renderVisitCheckoutContent()`);
 html=f.node('visit-checkout').innerHTML;assert.match(html,/&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/data-avs-version="2"/);assert.match(html,/opening the print dialog does not record that the summary was given/);assert.match(html,/does not collect a payment or mark charges paid/);
 f.run(`checkoutState.checkout={completed:true,checked_out_at:'2026-10-25T13:00:00Z'};renderVisitCheckoutContent()`);assert.match(f.node('visit-checkout').innerHTML,/type="submit" disabled>Finish encounter/);
 console.log('PASS released summaries escaped and handoff/payment statuses independent');
 f=fixture();f.run(`checkoutDrafts.set(checkoutContext.key,{instructions:'Retained instruction edits',follow_up_instructions:'',version:1,digest:'old-digest'});checkoutState.version=2;renderVisitCheckoutContent()`);
 assert.match(f.node('visit-checkout').innerHTML,/Retained instruction edits/);assert.match(f.node('visit-checkout').innerHTML,/data-version="1" data-digest="old-digest"/);assert.match(f.node('visit-checkout').innerHTML,/data-checkout-rebase/);
 f.run(`api=async(p,m,b,v)=>{calls.push({p,m,b,v});return {};};loadVisitCheckout=async()=>calls.push({refreshed:true});notice=()=>{};run=action=>pending.push(Promise.resolve().then(action));`);
 const form={id:'avs-release-form',dataset:{version:'1',digest:'old-digest'},values:{instructions:'Retained instruction edits',follow_up_instructions:'Follow up',reason:'Reviewed patient summary'},remove(){},closest(){return null;}};
 f.events.get('submit').find(e=>e.options===true).callback({target:form,preventDefault(){},stopImmediatePropagation(){}});await Promise.all(f.pending);
 const sent=JSON.parse(JSON.stringify(f.context.calls[0]));assert.equal(sent.v,1);assert.equal(sent.b.reviewed_snapshot_digest,'old-digest');assert.equal(sent.b.reviewed,true); assert.equal(sent.p,'/api/v1/patients/patient-1/visits/visit-1/checkout/actions');
 // The click that releases is the review: reviewed is sent true with no checkbox on screen.
 assert.equal(f.run(`$('visit-checkout').innerHTML.includes('name="reviewed"')`),false);
 console.log('PASS stale AVS edits retained with their original version and review digest');
  // The reviewed-copy rebase button: label, attribute and click handler path.
  f=fixture();f.run(`checkoutDrafts.set(checkoutContext.key,{instructions:'Retained instruction edits',follow_up_instructions:'',version:1,digest:'old-digest'});checkoutState.version=2;renderVisitCheckoutContent()`);
  html=f.node('visit-checkout').innerHTML;
  assert.match(html,/<button type="button" data-checkout-rebase>Use this reviewed copy<\/button>/);
  {
    const attr='data-checkout-rebase';
    const btn={hasAttribute:a=>a===attr,dataset:{},closest:sel=>sel==='button'?btn:null};
    let ran=false;
    f.run(`api=async(p,m,b,v)=>{calls.push({p,m,b,v});return {};};loadVisitCheckout=async()=>{throw new Error('rebase must not reload checkout');};notice=()=>{};captureCheckoutDraft=()=>{ran=true;};run=action=>pending.push(Promise.resolve().then(action));`);
    f.context.run('ran=false;');
    f.events.get('click').find(e=>e.options===true).callback({target:btn,preventDefault(){},stopImmediatePropagation(){}});
    await Promise.all(f.pending);
    assert.equal(f.context.ran,true,'captureCheckoutDraft (data-checkout-rebase handler) was not reached');
    assert.equal(f.context.calls.length,0,'rebase handler must not call the api or reload checkout');
    const draft=f.run(`checkoutDrafts.get(checkoutContext.key)`);
    assert.equal(draft.version,2);assert.equal(draft.digest,'digest-v1');
    assert.match(f.node('visit-checkout').innerHTML,/data-version="2" data-digest="digest-v1"/);
    assert.doesNotMatch(f.node('visit-checkout').innerHTML,/The checkout record or clinical information changed/);
  }
  // Every button tag in the checkout markup is closed with '>' before any '<'.
  for(const m of html.matchAll(/<button\b[^<]*/g))assert.ok(m[0].includes('>'),`unclosed <button tag: ${m[0]}`);
  console.log('PASS reviewed-copy rebase button rendered, clickable and self-closing');
 f=fixture();f.run(`followupAssignees=[{id:'staff-1',label:'Staff <unsafe>',role:'front_desk'}];checkoutState.followups=[{id:'task-1',patient_id:selected,visit_id:activeVisit.id,title:'Call <patient>',instructions:'Confirm follow-up',assignee_id:'staff-1',assignee_label:'Staff <unsafe>',due_date:'2026-10-24',status:'open',version:3,can_update:false}];renderVisitCheckoutContent()`);
 html=f.node('visit-checkout').innerHTML;assert.match(html,/Call &lt;patient&gt;/);assert.match(html,/Staff &lt;unsafe&gt;/);assert.doesNotMatch(html,/class="followup-action-form"/);assert.match(html,/Add task/);
 // Suggested follow-ups come only from this encounter's placed orders and open referrals, and never repeat a task already made.
 f=fixture();f.run("followupAssignees=[];workspace={labs:{orders:[{visit_id:'visit-1',status:'ordered',content:{title:'Panel <b>'}},{visit_id:'visit-1',status:'draft',content:{title:'Draft'}},{visit_id:'other',status:'ordered',content:{title:'Elsewhere'}}]}};checkoutReferrals=[{visit_id:'visit-1',status:'sent',content:{requested_service:'Cardiology consult',recipient:'Synthetic Heart Clinic',follow_up_due:'2031-01-05'}},{visit_id:'visit-1',status:'completed',content:{requested_service:'Done',recipient:'x'}}];");
 let suggested=JSON.parse(JSON.stringify(f.run('followupSuggestions(checkoutState)')));
 assert.deepEqual(suggested.map(x=>x.title),['Check result: Panel <b>','Follow up on referral: Cardiology consult']);assert.equal(suggested[1].due,'2031-01-05');assert.match(suggested[0].due,/^\d{4}-\d\d-\d\d$/);
 f.run('renderVisitCheckoutContent()');html=f.node('visit-checkout').innerHTML;assert.match(html,/data-followup-suggest="0">\+ Check result: Panel &lt;b&gt;</);
 f.run("checkoutState.followups=[{id:'t',title:'check result: panel <b>',status:'open',due_date:'2031-01-01',patient_id:'patient-1',visit_id:'visit-1',instructions:'',version:1}]");
 assert.deepEqual(JSON.parse(JSON.stringify(f.run('followupSuggestions(checkoutState).map(x=>x.title)'))),['Follow up on referral: Cardiology consult']);
 console.log('PASS follow-up rendering respects task permissions and escapes clinical text; suggestions come from this encounter only');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
