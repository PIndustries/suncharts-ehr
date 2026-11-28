// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const nodes=new Map(),handlers={},calls=[];
const node=id=>nodes.get(id)||(()=>{const item={id,innerHTML:'',dataset:{},values:{},hidden:false,scrollIntoView(){},replaceChildren(){this.innerHTML='';},insertAdjacentHTML(_where,html){this.innerHTML+=html;},querySelector(){return null;},querySelectorAll(selector){const line=/name="diagnosis_line_(\d+)"/.exec(selector);if(!line)return [];return (this.boxes||[]).filter(box=>box.checked);}};nodes.set(id,item);return item;})();
const account={id:'account',patient_id:'patient',version:3,status:'posted',total_cents:15000,content:{visit_id:'visit',service_date:'2026-11-10',lines:[{code:'99213',diagnosis_codes:['M62.81']}]},coverage_snapshot:{coverage:{content:{relationship:'self'}},payer:{content:{name:'Synthetic payer'}}}};
let claim={id:'claim',patient_id:'patient',account_id:'account',version:1,status:'draft',control_number:'SYN-CLAIM',frequency:'original',content:{diagnosis_codes:['M62.81'],line_diagnosis_pointers:[[1]],notes:''},snapshot:{account,patient:{id:'patient',given_name:'Synthetic',family_name:'Patient'}}};
const ctx={console,Map,JSON,Date,Error,crypto:{randomUUID:()=> 'stable-request'},document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn),querySelector:()=>null,querySelectorAll:()=>[]},$:node,me:{user_id:'clinician',role:'clinician'},selected:'patient',chartSection:'visits',encounterSection:'charges',encounterShows:part=>['visit','intake','documentation','charges','checkout'].includes(ctx.encounterSection)?['charges','note','intake','checkout'].includes(part):false,activeVisit:{id:'visit',appointment_id:'appointment'},workspace:{patient:{id:'patient'},billing:{accounts:[account]}},window:{},esc:v=>String(v??''),human:v=>v,date:v=>v,money:v=>String(v),sourceNotice:()=>'',chargeTable:()=>'',billingWrite:()=>true,billingField:(name,label,value)=>`<input name="${name}" value="${value||''}">`,selectField:()=>'',ediField:()=>'',workspaceResourceAllowed:()=>true,claimmdClaimProviderDefaults:()=>({}),loadClaimmdProviderDefaults:async()=>({}),setEncounterSection:key=>{ctx.chartSection='visits';ctx.encounterSection=key;},showTool:()=>{throw new Error('Must remain in selected encounter');},notice:()=>{},run:fn=>ctx.pending=fn(),loadEncounterRevenueStatus:async()=>{},encounterChargeAccount:()=>account,FormData:class{constructor(form){return Object.entries(form.elements?Object.fromEntries(Array.from(form.elements).filter(f=>f.name&&f.type!=='checkbox'||f.checked).map(f=>[f.name,f.type==='checkbox'?'on':f.value])):form.values||{})[Symbol.iterator]();}},api:async(path,method='GET',body,version)=>{
 calls.push({path,method,body,version});
 if(path.endsWith('/claimmd/status'))return {connected:true,active:{id:'setting',partner_id:'partner',partner_version:2,route_key:'claimmd'}};
 if(path.endsWith('/history'))return {items:[]};
 if(path.endsWith('/claims')&&method==='POST')return {...claim};
 if(path.endsWith('/actions')){claim={...claim,version:claim.version+1,status:'ready'};return claim;}
 if(path.endsWith('/837p'))return {id:'submission',version:1,claim_id:'claim',claim_version:version,partner_id:body.partner_id,partner_version:body.partner_version};
 if(path.endsWith('/delivery'))return {id:'delivery',submission_id:'submission',route_key:body.route_key};
 if(path.endsWith('/claim'))return {claim,preflight_issues:[],transport:{}};
 throw new Error('Unexpected API '+path);
}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/claims.js','utf8'),ctx);vm.runInContext(fs.readFileSync('web/claimmd-native.js','utf8'),ctx);
// Avoid timer/display complexity here; the tracking suite verifies those separately.
ctx.startClaimMdTracking=()=>{};ctx.claimMdClaimLifecycle=()=>'';
(async()=>{
 await ctx.showEncounterClaim('claim','account');
 assert.equal(ctx.chartSection,'visits');assert.equal(ctx.encounterSection,'charges');assert.match(node('encounter-claims-detail').innerHTML,/Claim review/);assert.equal(node('claims-detail').innerHTML,'');
 assert.match(node('encounter-claims-detail').innerHTML,/data-claim-primary/,'the claim shows one next step, not a column of steps');
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.encounterClaimRoute())),{account:'account',claim:'claim'});
 await ctx.beginClaim('account');assert.match(node('claim-editor').innerHTML,/Create claim/);assert.equal(ctx.chartSection,'visits');
 const values={diagnosis_codes:'M62.81',pointer_0:'1',frequency:'original',reason:'Reviewed synthetic encounter'};
 // The form as drawn, boxes included: the diagnosis ticks are read off the element itself.
 // The drawn form: its diagnosis boxes are read off the element, like every field on it.
 const drawnForm=()=>({dataset:{request:'stable-request'},values,claimViewContext:ctx.claimContextSnapshot(),claimAccount:account,querySelectorAll:node('claim-editor').querySelectorAll});
 const form=drawnForm();
 await ctx.saveClaimEditorForm(form,values);assert.equal(calls.filter(c=>c.path==='/api/v1/patients/patient/billing/accounts/account/claims').length,1);assert.match(node('encounter-claims-detail').innerHTML,/Claim review/);
 const action=node('claim-action');action.values={action:'ready',reason:'Reviewed ready'};
 handlers.submit[0]({target:action,preventDefault(){}});await ctx.pending;assert.equal(claim.status,'ready');assert.match(node('encounter-claims-detail').innerHTML,/data-claimmd-submit="claim"/);assert.equal(ctx.chartSection,'visits');
 let busy=false;ctx.run=fn=>{if(busy)return;busy=true;ctx.pending=Promise.resolve().then(fn).finally(()=>busy=false);};
 const button={type:'button',dataset:{claimmdSubmit:'claim'},hasAttribute:name=>name==='data-claimmd-submit',closest:selector=>selector==='#encounter-claims'?{}:null};
 for(const handler of handlers.click)handler({target:{closest:selector=>['button','[data-claimmd-submit]'].includes(selector)?button:null},preventDefault(){},stopImmediatePropagation(){}});
 await ctx.pending;assert.match(node('encounter-claims-detail').innerHTML,/Send claim to Claim.MD/,'native review action must reach its handler through the shared busy gate');
 const inlineActions={open:false};
 node('encounter-claims').closest=selector=>selector==='[data-step-claim-actions]'?inlineActions:null;
 ctx.invoiceTabSet=tab=>{ctx.encounterBillingTab=tab;};
 const beforeNativeReview=calls.length;
 assert.equal(await ctx.openEncounterClaimMdSubmit('claim','account'),true);
 assert.equal(ctx.encounterBillingTab,'billing','the native review opens the Billing area');
 assert.equal(node('encounter-claims').hidden,false,'the native review container is visible');
 assert.equal(inlineActions.open,true,'the continuous encounter reveals the native review inside Claim actions');
 assert.deepEqual(JSON.parse(JSON.stringify(ctx.encounterClaimRoute())),{account:'account',claim:'claim'});
 const markup=node('encounter-claims-detail').innerHTML;
 assert.match(markup,/id="claimmd-submit-form"/);
 const attestations=['signature_on_file','benefits_assigned','release_authorized','routine_professional_reviewed'];
 assert.match(markup,/name="claim_review_confirmed"[^>]* required/);
 assert.ok(calls.slice(beforeNativeReview).every(c=>c.method==='GET'),'opening the native confirmation does not submit or queue');
 const reviewed={reason:'Reviewed synthetic preparation',subscriber_given_name:'Synthetic',subscriber_family_name:'Member',
  patient_sex:'U',subscriber_sex:'U',rendering_given_name:'Test',rendering_family_name:'Clinician',billing_taxonomy:'207Q00000X',filing_indicator:'CI'};
 for(const prefix of ['billing','subscriber','patient','payer'])for(const [field,value] of Object.entries({line1:'1 Synthetic Way',line2:'',city:'Test City',state:'IL',postal_code:'60601'}))reviewed[prefix+'_'+field]=value;
 reviewed.claim_review_confirmed='on';
 const submit={dataset:{request:'stable-837p'},values:reviewed,claimViewContext:ctx.claimContextSnapshot(),claimRecord:claim,claimIdentity:ctx.me};
 await ctx.submitClaimMdForm(submit,{value:'queue'});
 const prepared=calls.find(c=>c.path.endsWith('/837p'));
 assert.equal(prepared.method,'POST');assert.equal(prepared.version,claim.version);
 assert.deepEqual(Object.keys(prepared.body).sort(),['details','partner_id','partner_version','reason','request_id']);
 assert.equal(prepared.body.partner_id,'partner');assert.equal(prepared.body.partner_version,2);
 assert.equal(prepared.body.reason,reviewed.reason);
 assert.equal(prepared.body.details.rendering_family_name,'Clinician');
 assert.equal(prepared.body.details.billing_address.postal_code,'60601');
 for(const key of attestations)assert.equal(prepared.body.details[key],true);
 const deliveries=calls.filter(c=>c.path.endsWith('/delivery'));
 assert.equal(deliveries.length,1);assert.equal(deliveries[0].body.route_key,'claimmd');assert.equal(deliveries[0].version,1);
 assert.equal(ctx.chartSection,'visits');

 const current=ctx.claimContextSnapshot(),draft={id:'claim-editor-form',dataset:{request:'draft-request'},elements:[{name:'notes',type:'textarea',value:'Saved note'}],claimViewContext:current,querySelector:()=>({disabled:false}),insertAdjacentHTML(_where,html){this.notice=html;}};
 ctx.restoreClaimDraft(draft,account,null,null);draft.elements[0].value='Unsaved encounter-specific packet note';ctx.captureClaimDraft(draft);
 const restored={...draft,dataset:{request:'new-request'},elements:[{name:'notes',type:'textarea',value:'Saved note'}]};ctx.restoreClaimDraft(restored,account,null,null);assert.equal(restored.elements[0].value,'Unsaved encounter-specific packet note');assert.equal(restored.dataset.request,'draft-request');assert(!restored.claimDraftStale);
 const changed={...restored,elements:[{name:'notes',type:'textarea',value:'New saved note'}]};ctx.restoreClaimDraft(changed,{...account,version:4},null,null);assert.equal(changed.claimDraftStale,true);assert.match(changed.notice,/Saved claim or charge data changed/);
 await assert.rejects(ctx.saveClaimEditorForm(changed,values),/The claim changed since you started/);

 const before=node('encounter-claims-detail').innerHTML,api=ctx.api;let resolve;
 ctx.api=path=>path.endsWith('/history')?Promise.resolve({items:[]}):new Promise(r=>resolve=r);
 const pending=ctx.showClaim('claim');ctx.selected='other-patient';resolve({claim,preflight_issues:[]});await pending;assert.equal(node('encounter-claims-detail').innerHTML,before,'late patient response cannot publish');
 const writes=calls.length;await assert.rejects(ctx.saveClaimEditorForm(form,values),/This page changed/);assert.equal(calls.length,writes,'old form cannot write after patient switch');
 ctx.selected='patient';ctx.api=api;await ctx.showEncounterClaim('claim','account');
 ctx.api=async(...args)=>{const result=await api(...args);if(args[0].endsWith('/837p'))ctx.activeVisit={id:'another-visit'};return result;};
 const priorDeliveries=calls.filter(c=>c.path.endsWith('/delivery')).length;
 await ctx.submitClaimMdForm({...submit,claimViewContext:ctx.claimContextSnapshot(),claimRecord:claim},{value:'queue'});assert.equal(calls.filter(c=>c.path.endsWith('/delivery')).length,priorDeliveries,'do not queue after encounter context changes during preparation');
 ctx.activeVisit={id:'visit'};ctx.api=api;await ctx.showEncounterClaim('claim','account');
 const originalIdentity=ctx.me;ctx.me={...originalIdentity};assert.equal(ctx.claimContextCurrent(ctx.claimContextSnapshot()),false,'new sign-in invalidates previous claim context');
 console.log('PASS encounter-contained claim preparation, readiness, native queue, retained/stale drafts, late reads and patient/session/visit mutation guards');
})().catch(error=>{console.error(error);process.exitCode=1;});
