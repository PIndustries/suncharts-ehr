// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}

// Only a real sign-out shows the sign-in screen. A failed list at startup keeps the app and offers
// a retry; a 401 from any request records which request (ids removed) and says so on the
// sign-in screen. Synthetic DOM and a stub fetch; nothing here touches a server.
function fixture(routes){
 const nodes=new Map(),store=new Map();
 const make=id=>({id,innerHTML:'',textContent:'',value:'',dataset:{},hidden:false,children:[],className:'',addEventListener(type,fn){(this.listeners??={})[type]=fn;},append(...items){for(const i of items)this.children.push(i);},setAttribute(){},removeAttribute(){},focus(){},scrollIntoView(){},classList:{contains(){return false;},remove(){},add(){}},replaceChildren(){},reset(){},remove(){}});
 const node=id=>nodes.get(id)||(nodes.set(id,make(id)),nodes.get(id));
 const calls=[];
 const context=vm.createContext({console,Date,Intl,URLSearchParams,TextEncoder,Promise,setTimeout:()=>0,clearTimeout(){},location:{search:''},window:{addEventListener(){},scrollTo(){}},crypto:{randomUUID:()=>'request-1'},
  sessionStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
  fetch:async(path)=>{calls.push(path);const r=routes(path);return {status:r.status,ok:r.status<400,json:async()=>r.body??{}};},
  document:{getElementById:node,querySelectorAll:()=>[],createElement:tag=>make(tag),addEventListener(){}},FormData:class{}});
 vm.runInContext(fs.readFileSync('web/app.js','utf8'),context);
 return {node,context,calls,store,run:s=>vm.runInContext(s,context)};
}
const me={user_id:'u1',tenant_id:'t1',role:'owner',email:'staff@example.test',display_name:'Synthetic Staff'};
(async()=>{
 // (a) a 500 from the patient list during startup
 let f=fixture(p=>p==='/auth/me'?{status:200,body:me}:p.startsWith('/api/v1/patients')?{status:500,body:{message:'boom'}}:{status:200,body:{}});
 await f.run('startApp()');
 assert.equal(f.node('login-screen').hidden,true,'the sign-in screen stays hidden');
 assert.equal(f.node('app').hidden,false,'the app shell stays');
 assert.match(f.node('notice').textContent,/couldn't finish loading\. Your sign-in is fine/);
 const retry=f.node('notice').children.find(c=>c.textContent==='Try again');
 assert.ok(retry,'a Try again button is offered');
 f.calls.length=0;retry.listeners.click();await new Promise(r=>setImmediate(r));
 assert.ok(f.calls.includes('/auth/me'),'Try again runs startup again');

 // (b) a 401 from /auth/me is a real sign-out
 f=fixture(()=>({status:401,body:{}}));
 await f.run('startApp()');
 assert.equal(f.node('login-screen').hidden,false);assert.equal(f.node('app').hidden,true);

 // (c) a 401 from a later request shows the sign-in screen with the recorded path, without ids
 f=fixture(()=>({status:401,body:{}}));
 f.run("me={user_id:'u1',tenant_id:'t1'}");
 await f.run("api('/api/v1/patients/123e4567-e89b-12d3-a456-426614174000/billing/visit-summary?visit_id=123e4567-e89b-12d3-a456-426614174000')").catch(e=>e);
 assert.equal(f.node('login-screen').hidden,false);
 assert.equal(f.node('login-signed-out').textContent,'You were signed out. If this keeps happening, tell support it happened at: /api/v1/patients/:id/billing/visit-summary');
 assert.ok(!/123e4567/.test(f.node('login-signed-out').textContent));
 assert.equal(f.store.has('suncharts.signedOutWhile'),false,'the note is shown once');
 console.log('sign-in startup failure checks ok');
})().catch(e=>{console.error(e);process.exit(1);});
