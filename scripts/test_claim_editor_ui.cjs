// SPDX-License-Identifier: AGPL-3.0-only
// The draft-claim form and the claim screen. The form ticks the diagnoses that apply to each charge
// line and submits them as the pointer numbers the server has always taken; the screen keeps one
// next step and folds everything else away. Stub DOM only, no jsdom.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const handlers={},nodes={},fields={},built={boxes:{}};
// The diagnosis tick boxes are drawn by the form and read back by it, so the fake node hands the
// form the very box objects its markup said were ticked - never every box, never none by accident.
const node=id=>nodes[id]??={innerHTML:'',scrollIntoView(){},insertAdjacentHTML(){},querySelector(){return null;},querySelectorAll(selector){const line=/name="diagnosis_line_(\d+)"/.exec(selector);if(!line)return [];return (built.boxes[`diagnosis_line_${line[1]}`]||[]).filter(box=>box.checked);}};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const account={id:'account',patient_id:'patient',version:5,status:'posted',total_cents:20000,content:{service_date:'2026-11-10',lines:[{code:'99213',diagnosis_codes:['M62.81','R26.89','M62.81']},{code:'97110',diagnosis_codes:['R26.89','M25.561']},{code:'97112',diagnosis_codes:['M25.561','M62.81']}]},coverage_snapshot:{coverage:{content:{relationship:'self',subscriber_birth_date:'1990-01-01'}},payer:{content:{name:'Synthetic payer'}}}};
const ctx={console,crypto:{randomUUID:()=>'synthetic-request'},document:{addEventListener:(event,handler)=>(handlers[event]??=[]).push(handler),querySelector:()=>({querySelector:()=>({insertAdjacentHTML(){}})})},$:node,esc,human:value=>value,date:value=>value,money:value=>String(value),sourceNotice:()=>'',chargeTable:()=>'',billingWrite:()=>true,claimMdConnectionState:{connected:true},selected:'patient',workspace:{patient:{id:'patient'},demographics:{patient_id:'patient',content:{address:{line1:'100 Synthetic Way',line2:'Suite 2',city:'Austin',region:'TX',postal_code:'78701',country:'US'}}}},billingField:(name,label,value)=>{fields[name]=value;return `<input name="${name}" value="${esc(value)}">`;},selectField:(name,label,options,value)=>{fields[name]=value;return '';},claimmdClaimProviderDefaults:()=>({billing_provider_name:'Synthetic Clinic',billing_npi:'1234567893'}),FormData:class{constructor(form){return Object.entries(form.values||{})[Symbol.iterator]();}},run:fn=>ctx.pending=fn(),notice:()=>{}};
// The live page loads billing.js before claims.js, so the claim form can lean on its helper for
// shaping a typed list of codes. Only that function is lifted in, not the rest of billing.
const billingHelpers=vm.createContext({console});
vm.runInContext(fs.readFileSync('web/billing.js','utf8').match(/function diagnosisCodeList[\s\S]*?\n}/)[0],billingHelpers);
ctx.diagnosisCodeList=vm.runInContext('diagnosisCodeList',billingHelpers);
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('web/claims.js','utf8'),ctx);
// The diagnosis list is a picker now (chips and a search box); what it holds is its hidden field.
{const real=ctx.claimDiagnosisPickerMarkup;ctx.claimDiagnosisPickerMarkup=codes=>{const html=real(codes);fields.diagnosis_codes=(html.match(/name="diagnosis_codes" value="([^"]*)"/)||[])[1];assert.doesNotMatch(html,/comma-separated/);assert.match(html,/data-claim-dx-search/);return html;};}

// Draws the claim form, then keeps the diagnosis boxes its markup drew. Ticking a box here is
// ticking it on the form, because the node hands the same object back to the form that reads it.
function draw(...rest){ctx.claimEditor(...rest);const html=node('claim-editor').innerHTML||'';return readBoxes(html);}
function readBoxes(html){
 built.boxes={};
 for(const row of html.matchAll(/data-diagnosis-line="(\d+)"[\s\S]*?<\/div>/g)){
  built.boxes[`diagnosis_line_${row[1]}`]=[...row[0].matchAll(/value="([^"]+)"( checked)?/g)].map(box=>({value:box[1],checked:box[2]===' checked'}));
 }
 return html;
}
const boxesOf=index=>built.boxes[`diagnosis_line_${index}`]||[];
const tick=(index,codes)=>boxesOf(index).forEach(box=>{box.checked=codes.includes(box.value);});

const original=JSON.stringify(account);
// 1. A fresh claim fills its diagnosis list in from the posted charges and ticks each charge line
//    with the diagnoses recorded against it - as ticks now, not as hand-typed pointer numbers.
draw(account);
assert.equal(fields.diagnosis_codes,'M62.81, R26.89, M25.561');
assert.deepEqual(boxesOf(0).map(box=>[box.value,box.checked]),[['M62.81',true],['R26.89',true],['M25.561',false]]);
assert.deepEqual(boxesOf(1).map(box=>[box.value,box.checked]),[['M62.81',false],['R26.89',true],['M25.561',true]]);
assert.deepEqual(boxesOf(2).map(box=>[box.value,box.checked]),[['M62.81',true],['R26.89',false],['M25.561',true]]);
assert.doesNotMatch(node('claim-editor').innerHTML,/diagnosis pointers|name="pointer_"/,'no hand-typed pointer boxes anywhere on the form');
assert.equal(fields.patient_address,'100 Synthetic Way, Suite 2, Austin, TX, 78701, US');assert.equal(fields.subscriber_address,fields.patient_address);
assert.equal(JSON.stringify(account),original,'defaulting a claim must not mutate posted charges');
draw({...account,coverage_snapshot:{...account.coverage_snapshot,coverage:{content:{relationship:'spouse'}}}});assert.equal(fields.subscriber_address,'');assert.match(fields.patient_address,/100 Synthetic Way/);
ctx.selected='other';draw(account);assert.equal(fields.patient_address,'');ctx.selected='patient';
ctx.workspace.demographics.patient_id='other';draw(account);assert.equal(fields.patient_address,'');ctx.workspace.demographics.patient_id='patient';
ctx.workspace.demographics.content.address.line1={invalid:true};draw(account);assert.equal(fields.patient_address,'');ctx.workspace.demographics.content.address.line1='100 Synthetic Way';
// 2. A reviewed draft re-opens with exactly its own pointers ticked, a corrected claim inherits the
//    original's, and a source packet starts empty because nobody has reviewed its diagnoses yet.
const reviewed={diagnosis_codes:['Z01.00','M62.81'],line_diagnosis_pointers:[[2],[1],[2,1]],patient_address:'Reviewed patient address',subscriber_address:'Reviewed subscriber address',notes:'Reviewed',synthetic_test:false};
draw(account,{id:'draft',content:reviewed});
assert.equal(fields.diagnosis_codes,'Z01.00, M62.81');
assert.deepEqual(boxesOf(0).map(box=>box.checked),[false,true]);
assert.deepEqual(boxesOf(1).map(box=>box.checked),[true,false]);
assert.deepEqual(boxesOf(2).map(box=>box.checked),[true,true]);
assert.equal(fields.patient_address,'Reviewed patient address');
draw(account,null,null,{id:'parent',payer_control_number:'SYN-PCN',content:reviewed});assert.equal(fields.diagnosis_codes,'Z01.00, M62.81');assert.deepEqual(boxesOf(2).map(box=>box.checked),[true,true]);assert.equal(fields.subscriber_address,'Reviewed subscriber address');
draw(account,null,{source_history_id:'source'});assert.equal(fields.diagnosis_codes,'');assert.deepEqual(built.boxes,{},'a source packet has no codes yet, so there is nothing to tick');assert.match(node('claim-editor').innerHTML,/Add a diagnosis above first/);assert.equal(fields.patient_address,'');

(async()=>{
 const claim={id:'claim',patient_id:'patient',account_id:'account',version:1,status:'ready',frequency:'original',control_number:'SYN-CLAIM',content:reviewed,snapshot:{account,patient:{given_name:'Avery',family_name:'Synthetic'}}};
 ctx.api=async url=>url.endsWith('/history')?{items:[]}:{claim,preflight_issues:[],transport:{claimmd_connected:true}};

 // 3. The claim screen: a ready claim with nothing missing says so in one line and offers one
 //    button. The record of something done outside SunCharts is still reachable, but folded away.
 await ctx.showClaim('claim');
 const screen=()=>node('claims-detail').innerHTML;
 const drawn=screen();
 assert.match(drawn,/>Send claim<\/button>/);assert.match(drawn,/Everything checks out/);
 assert.match(drawn,/data-claimmd-submit="claim"/);
 assert.equal((drawn.match(/<button[^>]*class="primary"/g)||[]).length,2,'one on the open screen, one inside the collapsed element');
 assert.equal((drawn.slice(0,drawn.indexOf('<details class="claim-more"')).match(/<button[^>]*class="primary"/g)||[]).length,1,'the open screen offers exactly one primary button');
 assert.match(drawn,/<details class="claim-more" data-claim-more-details><summary>More details/);
 assert.match(drawn,/Record activity outside SunCharts/);assert.match(drawn,/only if the claim was already sent outside SunCharts/);assert.match(drawn,/value="record_submission"/);

 // 4. A draft with nothing missing keeps its one send button and its hand-written release option.
 claim.status='draft';await ctx.showClaim('claim');
 assert.match(screen(),/data-claim-release="claim"[^>]*>Send claim<\/button>/);
 assert.match(screen(),/<summary>Other options for this claim<\/summary>/);assert.match(screen(),/<option value="ready">Release it to send later<\/option><option value="void_draft">/,'releasing or voiding a draft by hand stays reachable');assert.doesNotMatch(screen(),/Mark claim ready|mark it ready/);assert.doesNotMatch(screen(),/Record activity outside SunCharts/);
 claim.status='submitted';await ctx.showClaim('claim');assert.match(screen(),/Record activity outside SunCharts/);assert.match(screen(),/does not send a claim or record an insurance payment/);

 // 5. Saving reads the ticked boxes back as pointer numbers: counted against the code list, and a
 //    line with nothing ticked stays empty rather than silently pointing at the first diagnosis.
 draw(account);tick(0,['R26.89']);tick(1,[]);tick(2,['M25.561','M62.81']);
 const values={...fields,frequency:'original',notes:'Reviewed synthetic draft',reason:'Reviewed encounter coding'};
 const submitted=[];ctx.api=async(...args)=>{submitted.push(args);return {id:'new-claim'};};ctx.showClaimsWorkspace=async()=>{};ctx.showClaim=async()=>{};
 // The form the person was shown is what gets saved, boxes and all. Without the element's own
 // boxes there is nothing honest to read, and the claim's existing pointers are kept - never a
 // guess and never an emptying of the lines.
 const form={id:'claim-editor-form',dataset:{request:'synthetic-request',edit:'',parent:''},values,querySelectorAll:node('claim-editor').querySelectorAll};
 handlers.submit[0]({target:form,preventDefault(){}});await ctx.pending;
 assert.equal(submitted[0][0],'/api/v1/patients/patient/billing/accounts/account/claims');assert.equal(submitted[0][1],'POST');assert.equal(submitted[0][3],5);
 const content=JSON.parse(JSON.stringify(submitted[0][2].content));
 assert.deepEqual(content.diagnosis_codes,['M62.81','R26.89','M25.561']);
 assert.deepEqual(content.line_diagnosis_pointers,[[2],[],[1,3]],'the ticked boxes go back as pointer numbers counted against the code list');
 assert.equal(content.patient_address,content.subscriber_address);
 handlers.submit[0]({target:{id:'claim-editor-form',dataset:{request:'synthetic-request',edit:'',parent:''},values},preventDefault(){}});await ctx.pending;
 assert.deepEqual(JSON.parse(JSON.stringify(submitted[1][2].content)).line_diagnosis_pointers,claim.content.line_diagnosis_pointers,'no boxes to read means the pointers already on the claim survive');
 console.log('PASS claim draft ticks diagnoses per charge line and submits them as pointer numbers; the claim screen keeps one next step with everything else under More details');
})().catch(error=>{console.error(error);process.exitCode=1;});
