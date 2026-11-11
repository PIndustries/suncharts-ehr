// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/practice-billing.js','utf8');
const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
(async()=>{
 const host={innerHTML:''},editor={innerHTML:''},tools={innerHTML:'',hidden:true},button={disabled:false,isConnected:true},box={},form={dataset:{},isConnected:true,querySelector:q=>q==='[type="submit"]'?button:box,elements:{tax_id:{value:'000000017'}}},calls=[];
 const fields={name:'Synthetic organization',tax_id:'000000017',tax_id_type:'E',active:'true',reason:'Synthetic reviewed identity'};
 const c=vm.createContext({console,me:{role:'owner'},esc,date:String,crypto:{randomUUID:()=> 'stable-request'},document:{addEventListener(){}},FormData:class{constructor(){return Object.entries(fields);}},$:id=>({'tools':tools,'billing-organizations':host,'billing-org-editor':editor,'billing-org-form':form}[id]),showTool:()=>{},notice:()=>{},api:async(path,method,body,version)=>{calls.push({path,method,body,version});if(method)throw new Error('Synthetic uncertain response');return {items:[{id:'org',name:'Synthetic <organization>',tax_id_type:'E',tax_id_last4:'0017',version:3,active:true}]};}});
 vm.runInContext(source,c);await c.showBillingOrganizations();assert.match(host.innerHTML,/Synthetic &lt;organization>/);assert.match(host.innerHTML,/ending 0017/);assert.doesNotMatch(host.innerHTML,/000000017/);
 c.editBillingOrganization();assert.match(editor.innerHTML,/name="tax_id" type="password"/);assert.doesNotMatch(editor.innerHTML,/value="000000017"/);
 await c.saveBillingOrganization(form);await c.saveBillingOrganization(form);const posts=calls.filter(v=>v.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body.request_id,posts[1].body.request_id,'uncertain retry preserves stable request identity');assert.equal(posts[0].body.tax_id,'000000017','only explicit owner input is sent');
 c.editBillingOrganization('org');fields.tax_id='';await c.saveBillingOrganization(form);const put=calls.find(v=>v.method==='PUT');assert.equal(put.version,3);assert.equal(put.body.tax_id,undefined,'blank edit preserves server tax ID');assert.equal(put.body.request_id,undefined);
 const count=calls.length;c.me={role:'owner'};await c.saveBillingOrganization(form);assert.equal(calls.length,count,'changed session cannot publish the prior owner form');
 console.log('PASS masked organization list, explicit write-only tax input, stable uncertain retry, versioned preserve-secret update and stale-session guard');
})().catch(e=>{console.error(e);process.exitCode=1;});
