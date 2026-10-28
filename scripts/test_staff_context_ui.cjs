// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/app.js','utf8');
const api=source.slice(source.indexOf('async function api('),source.indexOf('\nfunction signInScreen'));
function fixture(){const nodes={'login-error':{}},ctx=vm.createContext({me:{tenant_id:'tenant-a',user_id:'user-a'},Error,JSON,signInScreen(){ctx.me=undefined;ctx.cleared=(ctx.cleared||0)+1;},$:id=>nodes[id],fetch:async()=>({ok:true,status:200,json:async()=>({ok:true})})});vm.runInContext(api,ctx);return{ctx,nodes,run:s=>vm.runInContext(s,ctx)};}
(async()=>{
 let f=fixture(),options;f.ctx.fetch=async(path,o)=>{options=o;return{ok:true,status:200,json:async()=>({ok:true})};};await f.run("api('/api/v1/patients')");assert.equal(options.headers['X-SunCharts-Staff-Context'],'tenant-a:user-a');
 f=fixture();f.ctx.fetch=async()=>({ok:false,status:409,json:async()=>({message:'Staff account changed. Sign in again to continue.'})});await assert.rejects(f.run("api('/auth/logout','POST')"),/Staff account changed/);assert.equal(f.ctx.cleared,1);assert.equal(f.nodes['login-error'].textContent,'Staff account changed. Sign in again to continue.');
 f=fixture();let resolve;f.ctx.fetch=()=>new Promise(r=>resolve=r);const pending=f.run("api('/api/v1/patients')");f.ctx.me={tenant_id:'tenant-b',user_id:'user-b'};resolve({ok:true,status:200,json:async()=>({secret:'stale A response'})});await assert.rejects(pending,/Staff account changed/);assert.equal(f.ctx.me.tenant_id,'tenant-b');assert.equal(f.ctx.cleared,undefined);
 f=fixture();let releaseJson;f.ctx.fetch=async()=>({ok:false,status:401,json:()=>new Promise(r=>releaseJson=r)});const old=f.run("api('/api/v1/patients')");await new Promise(setImmediate);f.ctx.me={tenant_id:'tenant-b',user_id:'user-b'};releaseJson({message:'authentication required'});await assert.rejects(old,/Staff account changed/);assert.equal(f.ctx.cleared,undefined);assert.equal(f.ctx.me.tenant_id,'tenant-b');
 f=fixture();f.ctx.me=undefined;f.ctx.fetch=async(path,o)=>{assert.equal(o.headers['X-SunCharts-Staff-Context'],undefined);return{ok:true,status:200,json:async()=>({user_id:'bootstrap'})};};assert.equal((await f.run("api('/auth/me')")).user_id,'bootstrap');
 console.log('PASS staff context: bound header, mismatch clears local UI without logout, stale responses rejected, bootstrap unbound');
})().catch(e=>{console.error(e);process.exit(1);});
