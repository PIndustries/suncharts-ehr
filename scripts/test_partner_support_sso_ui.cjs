// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/app.js','utf8');
const fn=source.match(/async function acceptConnectLaunch\(\)\{[\s\S]*?^\}/m)?.[0];
assert.ok(fn,'delegated support acceptance function is present');
assert.match(source,/const connectLaunchAcceptance=acceptConnectLaunch\(\);/,'fragment processing starts during the first deferred script');
assert.match(source,/me\.delegated_role==='partner_admin'[\s\S]*?'Partner administrator \(delegated\)'/,'delegated partner administrators have an attributable UI label');
function fixture(hash,pathname='/api/v1/connect/support/accept'){
 const calls=[],location={pathname,hash},history={replaceState(_a,_b,path){location.pathname=path;location.hash='';}};
 const context={URL,URLSearchParams,JSON,Error,location,history,takeHostedCopaySignInReturn:()=>null,takePatientPaymentSetupSignInReturn:()=>null,takePatientMembershipSignInReturn:()=>null,takeInvoiceCheckoutSignInReturn:()=>null,fetch:async(...args)=>{calls.push(args);assert.equal(location.hash,'','fragment must be cleared before exchange');return {ok:true,json:async()=>({kind:'staff'})};}};
 vm.createContext(context);vm.runInContext(fn,context);return {context,calls};
}
(async()=>{
 const code='synthetic-single-use-code-abcdefghijklmnopqrstuvwxyz0123456789',issuer='https://connect.suncharts.app';
 let f=fixture(`#code=${encodeURIComponent(code)}&issuer=${encodeURIComponent(issuer)}`);
 assert.equal(await f.context.acceptConnectLaunch(),true);assert.equal(f.context.location.pathname,'/');assert.equal(f.context.location.hash,'');assert.equal(f.calls.length,1);
 assert.equal(f.calls[0][0],'/api/v1/connect/support/accept');assert.deepEqual(JSON.parse(f.calls[0][1].body),{code,issuer});assert.equal(f.calls[0][1].credentials,'same-origin');
 assert.equal(f.calls[0][1].headers['X-SunCharts-Identity-Handoff'],'1');
 f=fixture(`#code=${encodeURIComponent(code)}&issuer=${encodeURIComponent(issuer)}`,'/');
 assert.equal(await f.context.acceptConnectLaunch(),true);assert.equal(f.context.location.pathname,'/');assert.equal(f.context.location.hash,'');assert.equal(f.calls.length,1);
 assert.equal(f.calls[0][0],'/api/v1/connect/identity/accept','root-shell launches use the staff identity exchange');
 f=fixture(`#code=${encodeURIComponent(code)}&issuer=${encodeURIComponent(issuer)}&next=claimmd`);
 assert.equal(await f.context.acceptConnectLaunch(),true);assert.equal(f.context.location.pathname,'/?open=claimmd');assert.equal(f.context.location.hash,'');assert.equal(f.calls.length,1);
 f=fixture(`#code=${encodeURIComponent(code)}&issuer=${encodeURIComponent(issuer)}&next=care-pathways`);
 assert.equal(await f.context.acceptConnectLaunch(),true);assert.equal(f.context.location.pathname,'/?open=workflow-studio');assert.equal(f.context.location.hash,'');assert.equal(f.calls.length,1);
 f=fixture(`#code=${encodeURIComponent(code)}&issuer=${encodeURIComponent(issuer)}&next=https%3A%2F%2Fevil.example`);
 assert.equal(await f.context.acceptConnectLaunch(),true);assert.equal(f.context.location.pathname,'/');assert.equal(f.context.location.hash,'');assert.equal(f.calls.length,1);
 f=fixture('#code=short&issuer=https%3A%2F%2Fconnect.suncharts.app');await assert.rejects(f.context.acceptConnectLaunch(),/invalid or incomplete/);assert.equal(f.context.location.hash,'');assert.equal(f.calls.length,0);
 f=fixture(`#code=${encodeURIComponent(code)}&issuer=https%3A%2F%2Fconnect.suncharts.app%2Fpath`);await assert.rejects(f.context.acceptConnectLaunch(),/invalid or incomplete/);assert.equal(f.calls.length,0);
 console.log('PASS delegated support UI: fragment cleared before same-origin exchange and invalid launches fail closed');
})().catch(error=>{console.error(error);process.exitCode=1;});
