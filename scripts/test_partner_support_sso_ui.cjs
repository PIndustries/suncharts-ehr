// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
const fn=source.match(/async function acceptPartnerSupportLaunch\(\)\{[\s\S]*?^\}/m)?.[0];
assert.ok(fn,'delegated support acceptance function is present');
assert.match(source,/const partnerSupportAcceptance=acceptPartnerSupportLaunch\(\);/,'fragment processing starts during the first deferred script');
function fixture(hash){
 const calls=[],location={pathname:'/api/v1/connect/support/accept',hash},history={replaceState(_a,_b,path){location.pathname=path;location.hash='';}};
 const context={URL,URLSearchParams,JSON,Error,location,history,fetch:async(...args)=>{calls.push(args);assert.equal(location.hash,'','fragment must be cleared before exchange');return {ok:true};}};
 vm.createContext(context);vm.runInContext(fn,context);return {context,calls};
}
(async()=>{
 const code='synthetic-single-use-code-abcdefghijklmnopqrstuvwxyz0123456789',issuer='https://connect.suncharts.app';
 let f=fixture(`#code=${encodeURIComponent(code)}&issuer=${encodeURIComponent(issuer)}`);
 assert.equal(await f.context.acceptPartnerSupportLaunch(),true);assert.equal(f.context.location.pathname,'/');assert.equal(f.context.location.hash,'');assert.equal(f.calls.length,1);
 assert.equal(f.calls[0][0],'/api/v1/connect/support/accept');assert.deepEqual(JSON.parse(f.calls[0][1].body),{code,issuer});assert.equal(f.calls[0][1].credentials,'same-origin');
 f=fixture('#code=short&issuer=https%3A%2F%2Fconnect.suncharts.app');await assert.rejects(f.context.acceptPartnerSupportLaunch(),/invalid or incomplete/);assert.equal(f.context.location.hash,'');assert.equal(f.calls.length,0);
 f=fixture(`#code=${encodeURIComponent(code)}&issuer=https%3A%2F%2Fconnect.suncharts.app%2Fpath`);await assert.rejects(f.context.acceptPartnerSupportLaunch(),/invalid or incomplete/);assert.equal(f.calls.length,0);
 console.log('PASS delegated support UI: fragment cleared before same-origin exchange and invalid launches fail closed');
})().catch(error=>{console.error(error);process.exitCode=1;});
