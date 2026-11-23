// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The emailed receipt lists services and codes only when staff tick the box, each time.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/patient-revenue.js','utf8');
const code=source.slice(source.indexOf('function receiptEmailMarkup('),source.indexOf('function openReceiptPreview('));
const calls=[];
const ctx={esc:v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),workspace:{demographics:{content:{email:'pat@example.test'}}},
 encodeURIComponent,crypto:{randomUUID:(()=>{let n=0;return()=>'id-'+(++n);})()},api:async(path,method,body)=>{calls.push({path,method,body});return {};},
 FormData:class{constructor(form){this.form=form;}get(name){return name==='email'?this.form.email:null;}}};
vm.createContext(ctx);vm.runInContext(code,ctx);
const mail={patient:'patient',receipt:{id:'receipt',appointment_id:'a',payment_group_id:null}};
const html=ctx.receiptEmailMarkup(mail);
assert.match(html,/<label class="review-ack"><input type="checkbox" name="include_services"> Include services and codes<\/label>/);
assert.doesNotMatch(html,/name="include_services"[^>]*checked/,'unticked by default');
assert.match(html,/Tick this when the patient asks for an itemised receipt\. The email will list what was done at the encounter\./);
const form=(email,ticked)=>({email,querySelector:s=>s==='[name=include_services]'?{checked:ticked}:{textContent:'',setAttribute(){},disabled:false}});
(async()=>{
 await ctx.sendReceiptEmail(form('pat@example.test',false),mail);
 await ctx.sendReceiptEmail(form('pat@example.test',false),mail);
 await ctx.sendReceiptEmail(form('pat@example.test',true),mail);
 await ctx.sendReceiptEmail(form('pat@example.test',true),mail);
 assert.equal(calls.length,4);
 assert.ok(!('include_services' in calls[0].body),'plain send carries no flag');
 assert.equal(calls[0].body.request_id,calls[1].body.request_id,'a repeated click is the same request');
 assert.equal(calls[2].body.include_services,true);
 assert.equal(calls[2].body.request_id,calls[3].body.request_id);
 assert.notEqual(calls[0].body.request_id,calls[2].body.request_id,'with and without services are different requests');
 console.log('receipt email services ui ok');
})();
