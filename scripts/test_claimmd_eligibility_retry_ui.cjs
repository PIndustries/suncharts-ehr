// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../web/claimmd-eligibility.js'),'utf8');
async function scenario(status,historyRequest='original-request'){
 const handlers={},calls=[],form={id:'claimmd-eligibility-form',dataset:{coverage:'coverage',request:'original-request'}},history={innerHTML:''};
 const fields={service_codes:'30',procedure_code:'',service_date:'2026-11-11',insured_given_name:'Synthetic',insured_middle_name:'',insured_family_name:'Patient',insured_birth_date:'1990-01-01',insured_sex:'',patient_sex:'',provider_id:'provider',billing_organization_id:'organization',provider_taxonomy:''};
 let pending,next=0;
 const context=vm.createContext({console,Date,Intl,URLSearchParams,selected:'patient',me:{id:'staff'},crypto:{randomUUID:()=>`new-request-${++next}`},
  FormData:class{constructor(){return Object.entries(fields);}},document:{addEventListener:(kind,fn)=>{handlers[kind]=fn;}},
  $:id=>id==='claimmd-eligibility-form'?form:history,esc:value=>String(value??''),human:String,date:String,notice:()=>{},
  run:fn=>{pending=fn();},api:async(url,method,body)=>{calls.push({url,method,body});if(method==='POST')throw new Error('Synthetic interrupted response');return {items:[{status,request_snapshot:{request:{request_id:historyRequest}},actor_id:'staff',response_snapshot:{elig:[]}}]};}
 });
 vm.runInContext(source,context);context.form=form;
 vm.runInContext("claimmdEligibilityContexts.set(form,{patientId:selected,identity:me,coverageId:'coverage',current:()=>true,directory:{providers:[{id:'provider',version:1}],billing_organizations:[{id:'organization',version:3}]}})",context);
 const event={target:form,preventDefault(){},stopImmediatePropagation(){}};
 handlers.submit(event);
 await assert.rejects(pending,/Synthetic interrupted response/);
 assert.equal(calls[0].body.request_id,'original-request');assert.equal(calls[0].body.provider_version,1);assert.equal(calls[0].body.billing_organization_version,3);assert.equal(calls[0].body.provider_taxid,undefined);
 assert.equal(calls.length,2,'always reconcile saved history before retrying');
 assert.ok(history.innerHTML.length>0);
 const expected=['failed','completed'].includes(status)&&historyRequest==='original-request'?'new-request-1':'original-request';
 assert.equal(form.dataset.request,expected);
 handlers.submit(event);
 await assert.rejects(pending,/Synthetic interrupted response/);
 assert.equal(calls[2].body.request_id,expected,'second click uses only the safely resolved request ID');
}
(async()=>{
 await scenario('failed');
 await scenario('completed');
 await scenario('pending');
 await scenario('failed','unrelated-request');
 console.log('PASS eligibility retry rotates confirmed failed/completed operations and preserves pending or unrelated IDs');
})().catch(error=>{console.error(error);process.exitCode=1;});
