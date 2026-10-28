// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic DOM fixtures; real browser acceptance is a separate check.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
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
 assert.match(f.node('visit-checkout').innerHTML,/data-version="0" data-digest="digest-v1"/);
 assert.match(f.node('visit-checkout').innerHTML,/Release after-visit summary/);
 assert.doesNotMatch(f.node('visit-checkout').innerHTML,/id="avs-delivery-form"|id="checkout-complete-form"/);
 f.run(`checkoutState.visit={...activeVisit,status:'in_progress'};renderVisitCheckoutContent()`);
 assert.match(f.node('visit-checkout').innerHTML,/Sign the encounter before/);assert.doesNotMatch(f.node('visit-checkout').innerHTML,/id="avs-release-form"/);
 for(const role of ['front_desk','read_only']){f.run(`me.role=${JSON.stringify(role)};checkoutState.visit=activeVisit;renderVisitCheckoutContent()`);assert.doesNotMatch(f.node('visit-checkout').innerHTML,/id="avs-release-form"/);}
 console.log('PASS unsigned encounters and role-protected AVS release');
 f=fixture();f.run(`checkoutState.current_avs={version:2,content:{instructions:'<script>unsafe()</script>',follow_up_instructions:'Call <clinic>'},snapshot:checkoutState.preview_snapshot,released_at:'2026-10-25T12:00:00Z'};checkoutState.releases=[checkoutState.current_avs];renderVisitCheckoutContent()`);
 let html=f.node('visit-checkout').innerHTML;assert.match(html,/&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/data-avs-version="2"/);assert.match(html,/Viewing or opening the print dialog does not record delivery/);assert.match(html,/checkout does not collect a payment/);
 f.run(`checkoutState.checkout={completed:true,checked_out_at:'2026-10-25T13:00:00Z'};renderVisitCheckoutContent()`);assert.match(f.node('visit-checkout').innerHTML,/type="submit" disabled>Complete administrative checkout/);
 console.log('PASS released summaries escaped and handoff/payment statuses independent');
 f=fixture();f.run(`checkoutDrafts.set(checkoutContext.key,{instructions:'Retained instruction edits',follow_up_instructions:'',version:1,digest:'old-digest'});checkoutState.version=2;renderVisitCheckoutContent()`);
 assert.match(f.node('visit-checkout').innerHTML,/Retained instruction edits/);assert.match(f.node('visit-checkout').innerHTML,/data-version="1" data-digest="old-digest"/);assert.match(f.node('visit-checkout').innerHTML,/data-checkout-rebase/);
 f.run(`api=async(p,m,b,v)=>{calls.push({p,m,b,v});return {};};loadVisitCheckout=async()=>calls.push({refreshed:true});notice=()=>{};run=action=>pending.push(Promise.resolve().then(action));`);
 const form={id:'avs-release-form',dataset:{version:'1',digest:'old-digest'},values:{instructions:'Retained instruction edits',follow_up_instructions:'Follow up',reason:'Reviewed patient summary'},remove(){},closest(){return null;}};
 f.events.get('submit').find(e=>e.options===true).callback({target:form,preventDefault(){},stopImmediatePropagation(){}});await Promise.all(f.pending);
 const sent=JSON.parse(JSON.stringify(f.context.calls[0]));assert.equal(sent.v,1);assert.equal(sent.b.reviewed_snapshot_digest,'old-digest');assert.equal(sent.b.reviewed,true);assert.equal(sent.p,'/api/v1/patients/patient-1/visits/visit-1/checkout/actions');
 console.log('PASS stale AVS edits retained with their original version and review digest');
 f=fixture();f.run(`followupAssignees=[{id:'staff-1',label:'Staff <unsafe>',role:'front_desk'}];checkoutState.followups=[{id:'task-1',patient_id:selected,visit_id:activeVisit.id,title:'Call <patient>',instructions:'Confirm follow-up',assignee_id:'staff-1',assignee_label:'Staff <unsafe>',due_date:'2026-10-24',status:'open',version:3,can_update:false}];renderVisitCheckoutContent()`);
 html=f.node('visit-checkout').innerHTML;assert.match(html,/Call &lt;patient&gt;/);assert.match(html,/Staff &lt;unsafe&gt;/);assert.doesNotMatch(html,/class="followup-action-form"/);assert.match(html,/Create assigned follow-up/);
 console.log('PASS follow-up rendering respects task permissions and escapes clinical text');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
