'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const source=fs.readFileSync('web/billing.js','utf8');

assert.match(source,/function coveragePayerSetup\(\)[\s\S]*No native payers are available[\s\S]*practice owner must add the payer/);
assert.match(source,/function coveragePayerForm\(\)[\s\S]*id="coverage-payer-form"[\s\S]*billingField\('payer_code','Claim\.MD payer ID','','text',100,true\)/);
assert.match(source,/Required here because insured accounts freeze this mapping when they are posted/);
assert.doesNotMatch(source,/Claim\.MD payer ID \(optional\)/);
assert.match(source,/button class="primary" type="submit" \$\{billingPayers\.length\?'':'disabled'\}>Save coverage/);
assert.match(source,/\['payer-form','coverage-payer-form','coverage-form'/);
assert.match(source,/f\.id==='coverage-payer-form'[\s\S]*api\('\/api\/v1\/billing\/payers','POST'/);
assert.match(source,/payer_code:data\.payer_code/);
assert.match(source,/select\.innerHTML=coveragePayerOptions\(payer\.id\)/);
assert.match(source,/Finish the coverage details, then save the coverage/);
assert.match(source,/<th>Claim\.MD payer ID<\/th>/);
assert.match(source,/name="local_only" value="true"/);
assert.match(source,/Post as local-only insurance activity/);
assert.match(source,/data\.local_only=data\.local_only==='true'/);
assert.match(source,/a\.status==='posted'&&frozenElectronicPayer/);
assert.match(source,/Local-only insurance account/);

const billingRust=fs.readFileSync('src/billing.rs','utf8');
assert.match(billingRust,/local_only: bool/);
assert.match(billingRust,/missing_electronic_payer && !v\.local_only/);
assert.match(billingRust,/add the correct Claim\.MD payer ID in the payer mapping before posting/);

const claimsRust=fs.readFileSync('src/claims.rs','utf8');
assert.match(claimsRust,/Claim\.MD payer ID is missing from the frozen payer mapping/);
assert.doesNotMatch(claimsRust,/Payer \{field\} is required/);

console.log('PASS empty coverage payer directories expose inline native payer setup and select the created Claim.MD-mapped payer');

// Exercise the real busy wrapper and delegated submit handler together. A
// source-only assertion missed run() restoring the original disabled state.
const vm=require('node:vm'),app=fs.readFileSync('web/app.js','utf8');
function coverageFixture(){
 const handlers={},calls=[],notices=[];let currentButton;
 function button(disabled){return {disabled,isConnected:true,cloneNode(){return button(this.disabled);},replaceWith(replacement){this.isConnected=false;currentButton=replacement;}};}
 currentButton=button(true);const originalButton=currentButton,payerButton=button(false);
 const fields={payer_id:{value:''},priority:{value:'primary'},status:{value:'active'},member_id:{value:'SYNTHETIC-MEMBER'},group_number:{value:'reviewed-group'},plan_name:{value:'Synthetic plan'},subscriber_name:{value:'Synthetic Subscriber'},subscriber_birth_date:{value:'1980-01-01'},relationship:{value:'self'},effective_date:{value:'2026-01-01'},end_date:{value:''},copay:{value:'25.00'},verification:{value:'unverified'},notes:{value:'Retain these coverage details'},reason:{value:'Reviewed synthetic coverage'}};
 Object.defineProperty(fields.payer_id,'innerHTML',{set(html){this.html=html;this.value=html.match(/value="([^"]+)" selected/)?.[1]||'';},get(){return this.html||'';}});
 const coverage={id:'coverage-form',dataset:{id:'',version:'',request:'coverage-request',source:''},elements:fields,querySelector:()=>currentButton};
 const form={id:'coverage-payer-form',dataset:{request:'payer-request'},data:{name:'Synthetic payer',payer_code:'SYNTHETIC-LOCAL',phone:'',address:''}};
 const nodes={'notice':{hidden:true},'shell-loading':{hidden:true},'login-error':{},'coverage-form':coverage,'coverage-payer-setup':{innerHTML:''}};
 let resolve,reject;
 const ctx={console,Intl,Date,me:{role:'owner'},selected:'synthetic-patient',activeVisit:undefined,busy:false,chartSection:'insurance',document:{addEventListener:(event,fn)=>(handlers[event]??=[]).push(fn),querySelectorAll:()=>[currentButton,payerButton].filter(b=>b.isConnected),documentElement:{classList:{add(){},remove(){}}}},window:{},$:id=>nodes[id],esc:String,FormData:class{constructor(form){this.data=form.data||Object.fromEntries(Object.entries(form.elements).map(([k,v])=>[k,v.value]));}[Symbol.iterator](){return Object.entries(this.data)[Symbol.iterator]();}},api:async(path,method,body)=>{calls.push({path,method,body});if(path==='/api/v1/billing/payers')return new Promise((yes,no)=>{resolve=yes;reject=no;});return {id:'coverage-id'};},notice:(message,error)=>notices.push({message,error}),selectPatient:async()=>{},showChartSection:()=>{}};
 vm.createContext(ctx);vm.runInContext(source,ctx);vm.runInContext(app.slice(app.indexOf('async function run('),app.indexOf('async function enter(')),ctx);
 const nativeRun=ctx.run;ctx.run=fn=>ctx.pending=nativeRun(fn);
 return {ctx,fields,form,coverage,calls,notices,originalButton,currentButton:()=>currentButton,submit(form){handlers.submit.forEach(h=>h({target:form,preventDefault(){}}));return ctx.pending;},resolve(){resolve({id:'payer-id',content:{name:'Synthetic payer',payer_code:'SYNTHETIC-LOCAL',active:true}});},reject(){reject(Error('Payer could not be created'));}};
}
(async()=>{
 let f=coverageFixture();const expected=Object.fromEntries(Object.entries(f.fields).filter(([k])=>k!=='payer_id').map(([k,v])=>[k,v.value]));
 const adding=f.submit(f.form);assert.equal(f.ctx.busy,true);assert.equal(f.currentButton().disabled,true,'coverage stays unavailable while payer creation is pending');
 f.resolve();await adding;
 assert.equal(f.ctx.busy,false);assert.equal(f.fields.payer_id.value,'payer-id');assert.equal(f.currentButton().disabled,false,'run finally must not restore the stale empty-directory disabled state');
 assert.equal(f.originalButton.isConnected,false);assert.equal(f.coverage.elements,f.fields,'the form and field nodes are preserved');
 for(const [key,value] of Object.entries(expected))assert.equal(f.fields[key].value,value,key+' was preserved');
 assert.equal(f.calls.length,1,'adding a payer does not submit the unsaved coverage');
 await f.submit(f.coverage);assert.equal(f.calls.length,2);assert.equal(f.calls[1].path,'/api/v1/patients/synthetic-patient/coverages');
 assert.equal(f.calls[1].body.content.payer_id,'payer-id');assert.equal(f.calls[1].body.content.member_id,'SYNTHETIC-MEMBER');assert.equal(f.calls[1].body.content.copay_cents,2500);assert.equal(f.calls[1].body.reason,expected.reason);
 assert.equal(f.currentButton().disabled,false,'the next normal form submission keeps its enabled state');
 f=coverageFixture();const failing=f.submit(f.form);f.reject();await failing;
 assert.equal(f.currentButton(),f.originalButton);assert.equal(f.currentButton().disabled,true,'failed payer creation cannot enable coverage');assert.equal(f.fields.payer_id.value,'');assert.equal(f.fields.member_id.value,'SYNTHETIC-MEMBER');assert.equal(f.calls.length,1);assert.ok(f.notices.some(n=>n.error));
 console.log('PASS real busy wrapper retains enabled coverage submit after first payer creation, preserves fields and submits only on explicit Save; failures remain disabled');
})().catch(error=>{console.error(error);process.exitCode=1;});
