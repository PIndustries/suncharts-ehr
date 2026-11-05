// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('web/claimmd-extended.js','utf8');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function fixture(){
 const handlers={},calls=[];let html='',editor='';
 const nodes={
  'edi-automation':{insertAdjacentHTML:(_where,value)=>{html+=value;}},
  'claimmd-operation-editor':{set innerHTML(value){editor=value;},get innerHTML(){return editor;},scrollIntoView(){}},
 };
 const context={
  console,Date,JSON,encodeURIComponent,location:{origin:'https://ehr.synthetic.test'},me:{role:'owner'},
  esc:escape,human:value=>String(value),date:value=>String(value),$:id=>nodes[id],
  document:{addEventListener:(kind,fn)=>{handlers[kind]=fn;}},
  api:async(path,method,body)=>{calls.push({path,method,body});if(path.endsWith('/operations'))return {operations:[],era_documents:[],webhook_events:[]};if(path==='/api/v1/billing/provider-settings')return {items:[{id:'setting-1',label:'Synthetic <account>',usage:'T',enabled:true,verified:true}]};if(path==='/api/v1/billing/submissions')return {items:[{claim_id:'claim-1',patient_name:'Doe, Synthetic',claim_control:'CTRL-1'}]};if(path.endsWith('/appeals'))return {external_url:'https://www.claim.md/appeal/synthetic'};return {};},
  run:fn=>{context.pending=fn();},notice:()=>{},showEdiWorkspace:async()=>{},
  FormData:class{constructor(form){return Object.entries(form.values)[Symbol.iterator]();}},
  window:{open:(url)=>{context.opened=url;}},
 };
 vm.createContext(context);vm.runInContext(source,context);
 return {context,handlers,calls,html:()=>html,editor:()=>editor,run:code=>vm.runInContext(code,context)};
}

(async()=>{
 const f=fixture();
 await f.run('showClaimMdExtended()');
 assert.match(f.html(),/Claim\.MD native services/);
 assert.match(f.html(),/https:\/\/ehr\.synthetic\.test\/api\/v1\/billing\/claimmd\/webhook\/setting-1/);
 assert.match(f.html(),/Synthetic &lt;account&gt;/);
 f.run('showClaimMdAppealEditor()');
 assert.match(f.editor(),/Doe, Synthetic · CTRL-1/);
 const form={id:'claimmd-appeal-form',values:{setting_id:'setting-1',native_claim_id:'claim-1',claimid:'',reason:'Reviewed denial'}};
 f.handlers.submit({target:form,preventDefault(){}});await f.context.pending;
 const request=f.calls.find(call=>call.path.endsWith('/appeals'));
 assert.equal(JSON.stringify(request.body),JSON.stringify({setting_id:'setting-1',native_claim_id:'claim-1',reason:'Reviewed denial'}));
 assert.equal(f.context.opened,'https://www.claim.md/appeal/synthetic');
 console.log('PASS Claim.MD native workflows render scoped callbacks and preserve native claim identity');
})().catch(error=>{console.error(error);process.exitCode=1;});
