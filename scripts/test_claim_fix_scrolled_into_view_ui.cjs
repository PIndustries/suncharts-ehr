// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Pressing "Fix claim details" renders the claim editor far down the page. The editor must
// scroll into view and move focus to its heading, the same way the billing editor does.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const account={id:'account',patient_id:'patient',version:1,status:'posted',total_cents:28000,content:{visit_id:'visit',service_date:'2026-11-12',lines:[{code:'99213',diagnosis_codes:['M62.81']}]},coverage_snapshot:{coverage:{content:{relationship:'self'}},payer:{content:{name:'Synthetic payer'}}}};
const claim={id:'claim',patient_id:'patient',account_id:'account',version:1,status:'draft',control_number:'SYN-CLAIM',frequency:'original',content:{diagnosis_codes:['M62.81'],line_diagnosis_pointers:[[1]],notes:''},snapshot:{account,patient:{id:'patient',given_name:'Synthetic',family_name:'Patient'}}};

function fixture(){
 const nodes={},scrolls=[],headings=[];
 const host={id:'encounter-claims-detail',innerHTML:'',scrollIntoView(options){scrolls.push({id:this.id,...options});},querySelector(){return null;},insertAdjacentHTML(){},replaceChildren(){this.innerHTML='';}};
 const heading={tabIndex:null,focused:null,focus(options){headings.push({...options});this.focused=true;}};
 const editor={id:'claim-editor',innerHTML:'',scrollIntoView(options){scrolls.push({id:this.id,...options});},querySelector(selector){return selector==='#claim-editor-form h3'?heading:null;},insertAdjacentHTML(){}};
 const context={console,Map,Set,JSON,Date,Error,crypto:{randomUUID:()=>'stable-request'},
  document:{addEventListener(){},querySelector:()=>({querySelector:()=>({insertAdjacentHTML(){}})})},
  $:id=>nodes[id]??(nodes[id]=id==='claim-editor'?editor:host),
  me:{role:'billing_staff'},selected:'patient',chartSection:'visits',encounterSection:'charges',activeVisit:{id:'visit',appointment_id:'appointment'},
  workspace:{patient:{id:'patient'},billing:{accounts:[account]}},
  esc:v=>String(v??''),human:v=>v,date:v=>v,displayDate:v=>v,money:v=>String(v),sourceNotice:()=>'',chargeTable:()=>'',
  billingWrite:()=>true,billingField:(name,label,value)=>`<input name="${name}" value="${value||''}">`,selectField:()=>'',
  setEncounterSection(){},notice:()=>{},run:fn=>context.pending=fn(),  api:async path=>path.endsWith('/history')?{items:[]}:({claim,preflight_issues:[{code:'tax_id'}],transport:{}}),
  loadClaimmdProviderDefaults:async()=>({}),claimmdClaimProviderDefaults:()=>({}),startClaimMdTracking(){},claimMdClaimLifecycle:()=>'',loadEncounterRevenueStatus:async()=>{},loadClaimMdConnection:async()=>({connected:false}),
  FormData:class{constructor(form){return Object.entries(form.values||{})[Symbol.iterator]();}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('web/claims.js','utf8'),context);
 return {context,host,editor,heading,scrolls,headings};
}

(async()=>{
 const f=fixture();
 await f.context.showEncounterClaim('claim','account');
 f.context.claimEditor(account,f.context.claimCurrent);
 assert.deepEqual(f.scrolls.at(-1),{id:'claim-editor',block:'start'},'the editor host scrolls to the top of the screen');
 assert.equal(f.heading.tabIndex,-1,'the heading can take focus for screen readers');
 assert.deepEqual(f.headings.at(-1),{preventScroll:true},'focus moves to the heading without a second scroll');
 // The heading of the rendered form itself, not a stub, must receive focus.
 assert.match(f.editor.innerHTML,/<form id="claim-editor-form"[^>]*><h3>Edit draft claim<\/h3>/,'the draft editor is rendered before focus moves');
 console.log('PASS fixing claim details scrolls the editor into view and moves focus to its heading');
})().catch(error=>{console.error(error);process.exitCode=1;});
