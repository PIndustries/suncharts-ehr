// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),context);return context;};}

// Startup keeps the destination hidden until it is ready and offers a retry after a read failure.
// A 401 in an authenticated session shows a session-ended notice. A cold visit stays quiet.
function fixture(routes){
 const {JSDOM}=require('jsdom');
 const dom=new JSDOM(fs.readFileSync('web/index.html','utf8'),{url:'http://localhost/'}),store=new Map();
 const getElementById=dom.window.document.getElementById.bind(dom.window.document);
 dom.window.document.getElementById=id=>{assert.notEqual(id,'login-connect-state','removed connection status is never accessed');return getElementById(id);};
 const node=id=>{const element=dom.window.document.getElementById(id)||dom.window.document.querySelector('#login-form [name="'+id+'"]');assert(element,'fixture includes '+id);return element;};
 const calls=[];
 const context=vm.createContext({console,Date,Intl,URLSearchParams,TextEncoder,Promise,setTimeout:()=>0,clearTimeout(){},location:{search:''},window:{addEventListener(){},scrollTo(){}},crypto:{randomUUID:()=>'request-1'},
  sessionStorage:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)},
  fetch:async(path,options)=>{calls.push(path);const r=await routes(path,options?.method);return {status:r.status,ok:r.status<400,json:async()=>r.body??{}};},
  document:dom.window.document,FormData:dom.window.FormData,
  loadPracticeWorkspaceSettings:()=>context.api('/api/v1/practice/workspace-settings'),
  showPracticeWorkspace:async()=>{await context.api('/api/v1/practice/overview');node('tools').hidden=false;node('tools').textContent='Home';}});
 vm.runInContext(fs.readFileSync('web/app.js','utf8'),context);
 return {node,context,calls,store,Event:dom.window.Event,run:s=>vm.runInContext(s,context)};
}
const me={user_id:'u1',tenant_id:'t1',role:'owner',email:'staff@example.test',display_name:'Synthetic Staff'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 // (a) a destination read fails during reload. Recovery stays on the startup screen.
 let resolveHome;
 const homeRead=new Promise(resolve=>{resolveHome=resolve;});
 let f=fixture(p=>p==='/auth/me'?{status:200,body:me}:p==='/api/v1/practice/overview'?homeRead:{status:200,body:{}});
 assert.equal(f.node('login-screen').hidden,true);
 assert.equal(f.node('workspace-startup').hidden,false);
 const opening=f.run('startApp()');await tick();
 assert.ok(f.calls.includes('/api/v1/practice/overview'));
 assert.ok(!f.calls.includes('/api/v1/patients'),'Home startup skips the directory');
 assert.equal(f.node('app').hasAttribute('inert'),true);
 resolveHome({status:500,body:{message:'boom'}});await opening;
 assert.equal(f.node('login-screen').hidden,true);
 assert.equal(f.node('app').hasAttribute('inert'),true);
 assert.equal(f.node('workspace-startup').hidden,false);
 assert.match(f.node('startup-status').textContent,/couldn't finish loading/);
 const retry=f.node('startup-retry');assert.equal(retry.hidden,false);
 f.calls.length=0;retry.click();await tick();
 assert.ok(f.calls.includes('/auth/me'),'Try again reruns startup');

 // (b) a 401 from /auth/me on a normal first visit shows no session-ended note
 f=fixture(()=>({status:401,body:{}}));
 await f.run('startApp()');
 assert.equal(f.node('login-screen').hidden,false);assert.equal(f.node('app').hidden,true);
 assert.equal(f.node('workspace-startup').hidden,true);
 assert.equal(f.node('login-signed-out').textContent,'');

 // (c) a 401 from a later request shows only the calm notice, with no stored request details
 f=fixture(()=>({status:401,body:{}}));
 f.run("me={user_id:'u1',tenant_id:'t1'}");
 await f.run("run(()=>api('/api/v1/patients/123e4567-e89b-12d3-a456-426614174000/billing/visit-summary?visit_id=123e4567-e89b-12d3-a456-426614174000'))");
 assert.equal(f.node('login-screen').hidden,false);
 assert.equal(f.node('login-signed-out').textContent,'Your session ended. Sign in again to carry on.');
 assert.equal(f.node('login-error').textContent,'','the action handler adds no second sign-in message');
 assert.equal(f.store.size,0,'no sign-out path or status is stored');
 f.run('signInScreen()');
 assert.equal(f.node('login-signed-out').textContent,'','ordinary sign-in clears the notice');

 // (d) a 401 while loading an authenticated app keeps the notice through startup handling
 f=fixture(p=>p==='/auth/me'?{status:200,body:me}:{status:401,body:{}});
 await f.run('startApp()');
 assert.equal(f.node('login-signed-out').textContent,'Your session ended. Sign in again to carry on.');

 // (e) Connect and local mode still select the right sign-in controls
 f=fixture(()=>({status:200,body:{mode:'connect',staff_sign_in_url:'https://connect.example.test/sign-in'}}));
 await f.run('refreshSignInMode()');
 assert.equal(f.node('connect-login').hidden,false);
 assert.equal(f.node('connect-login').href,'https://connect.example.test/sign-in');
 assert.equal(f.node('local-login-fields').hidden,true);
 assert.equal(f.node('email').required,false);
 assert.equal(f.node('password').required,false);
 assert.equal(f.node('login-description').textContent,'Use your SunCharts Connect passkey or emailed sign-in link.');

 // (f) an unreadable mode leaves the server-rendered Connect button working and adds no text
 for(const reply of [()=>({status:503}),()=>{throw new Error('offline');}]){
  f=fixture(reply);
  f.node('connect-login').href='https://connect.example.test/sign-in';
  f.node('connect-login').hidden=false;
  f.node('login-description').textContent='Use your SunCharts Connect passkey or emailed sign-in link.';
  await f.run('refreshSignInMode()');
  assert.equal(f.node('connect-login').href,'https://connect.example.test/sign-in');
  assert.equal(f.node('connect-login').hidden,false);
  assert.equal(f.node('login-description').textContent,'Use your SunCharts Connect passkey or emailed sign-in link.');
  assert.equal(f.node('login-error').textContent,'');
  assert.equal(f.node('login-signed-out').textContent,'');
 }
 f=fixture(()=>({status:200,body:{mode:'local'}}));
 await f.run('refreshSignInMode()');
 assert.equal(f.node('connect-login').hidden,true);
 assert.equal(f.node('local-login-fields').hidden,false);
 assert.equal(f.node('email').required,true);
 assert.equal(f.node('password').required,true);

 // (g) local sign-in uses the same recovery screen, then retry opens the destination.
 let signedIn=false,destinationAvailable=false;
 f=fixture(p=>{
  if(p==='/auth/login'){signedIn=true;return {status:200};}
  if(p==='/auth/me')return signedIn?{status:200,body:me}:{status:401};
  if(p==='/api/v1/practice/overview')return {status:destinationAvailable?200:503};
  return {status:200};
 });
 await f.run('startApp()');
 f.node('login-form').dispatchEvent(new f.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(f.node('login-screen').hidden,true);
 assert.equal(f.node('workspace-startup').hidden,false);
 assert.equal(f.node('startup-retry').hidden,false);
 destinationAvailable=true;f.node('startup-retry').click();await tick();
 assert.equal(f.node('workspace-startup').hidden,true);
 assert.equal(f.node('app').hasAttribute('inert'),false);
 assert.equal(f.node('tools').textContent,'Home');

 // (h) a late failure from an expired session cannot interrupt the next sign-in.
 let reauthenticated=false,finishExpiredRead;
 const expiredRead=new Promise(resolve=>{finishExpiredRead=resolve;});
 f=fixture(p=>{
  if(p==='/auth/login')reauthenticated=true;
  if(p==='/auth/me')return {status:200,body:me};
  if(p==='/api/v1/practice/overview'&&!reauthenticated)return {status:401};
  return {status:200};
 });
 f.context.showPracticeWorkspace=async()=>{
  try{await f.context.api('/api/v1/practice/overview');}
  catch{await expiredRead;throw new Error('Late startup failure');}
  f.node('tools').hidden=false;f.node('tools').textContent='Home';
 };
 const expiredOpening=f.run('startApp()');await tick();
 assert.equal(f.node('login-screen').hidden,false);
 assert.equal(f.node('workspace-startup').hidden,true);
 f.node('login-form').dispatchEvent(new f.Event('submit',{bubbles:true,cancelable:true}));await tick();
 assert.equal(f.node('app').hasAttribute('inert'),false,'a fresh sign-in can open before the old read completes');
 finishExpiredRead();await expiredOpening;
 assert.equal(f.node('app').hasAttribute('inert'),false);
 assert.equal(f.node('startup-retry').hidden,true);
 assert.equal(f.node('workspace-startup').hidden,true);

 const html=fs.readFileSync('web/index.html','utf8');
 assert.doesNotMatch(html,/login-connect-state|login-connection|__CONNECT_STATE_VISIBILITY__/);
 console.log('sign-in startup failure checks ok');
})().catch(e=>{console.error(e);process.exit(1);});
