// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/card-readers.js','utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ready={status:'ready',client_secret:'accs_secret__synthetic',publishable_key:'pk_test_synthetic',livemode:false};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
// A stand-in for Connect.js: records init options, created elements and appearance updates.
function stripeStub(log){
 return {init:options=>{const instance={options,created:[],updates:[],loggedOut:0,
   create:name=>{const element={name,setOnLoadError(fn){this.loadError=fn;},setOnCheckoutFinished(fn){this.checkoutFinished=fn;}};instance.created.push(element);return element;},
   update:value=>instance.updates.push(value),logout:()=>{instance.loggedOut++;}};log.instances.push(instance);return instance;}};
}
function fixture(response=ready,browserSerialization=false){
 const host=id=>({id,children:[],appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;}});
 const tools={hidden:false,_html:'',get innerHTML(){return browserSerialization?this._html.replace(/ (data-[a-z-]+)(?=[ >])/g,' $1=""'):this._html;},set innerHTML(value){this._html=value;for(const id of ['card-reader-shop','card-reader-orders','card-reader-status'])if(value.includes(`id="${id}"`))nodes[id]=host(id);else delete nodes[id];}};
 const nodes={tools},calls=[],handlers={},scripts=[],log={instances:[]};
 const timers=[];const context={console,Promise,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cleared=true;},me:{role:'owner',tenant_id:'tenant',user_id:'owner'},$:id=>nodes[id],esc,
  api:async(...args)=>{calls.push(args);if(typeof context.response==='function')return context.response();return context.response;},response,
  showTool:title=>{context.page=title;tools.hidden=false;},run:fn=>{context.pending=fn();return context.pending;},
  document:{documentElement:{dataset:{theme:'light'}},head:{appendChild:script=>scripts.push(script)},createElement:tag=>({tag,remove(){this.removed=true;}}),addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn)}};
 context.window=context;vm.createContext(context);vm.runInContext(source,context);
 // Connect.js finishes loading: it defines StripeConnect.init and calls StripeConnect.onLoad.
 const loadStripe=()=>{Object.assign(context.StripeConnect,stripeStub(log));context.StripeConnect.onLoad();};
 const open=async()=>{const opening=vm.runInContext('openCardReaders()',context);opening.catch(()=>{});await new Promise(r=>setImmediate(r));if(scripts.length&&!log.loaded&&context.autoLoad!==false){log.loaded=true;loadStripe();}await opening;};
 return {context,nodes,tools,calls,handlers,scripts,log,timers,open,loadStripe,run:code=>vm.runInContext(code,context)};
}
const visibleText=html=>html.replace(/<[^>]*>/g,' ');
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('practice without finished payment setup sees a plain message and the payment setup button',async()=>{
 const f=fixture({status:'not_connected'});await f.open();const html=f.tools.innerHTML;
 assert.equal(JSON.stringify(f.calls),JSON.stringify([['/api/v1/billing/payments/readers/hardware-session','POST',{}]]));
 assert.equal(f.context.page,'Card readers');
 assert.match(html,/<h2>Card readers<\/h2>/);
 assert.match(html,/Readers are ordered from Stripe, shipped to the practice and billed by Stripe\./);
 assert.match(html,/Finish payment setup before ordering a reader\./);
 assert.equal(html.match(/data-payment-settings/g).length,1,'one button to the existing payment setup');
 assert.match(html,/<button type="button" class="primary" data-payment-settings>Payment setup<\/button>/);
 assert.doesNotMatch(html,/Order a reader|Your orders|card-reader-shop/);
 assert.equal(f.scripts.length,0,'Stripe is not loaded until there is a shop to show');
});
test('reader ordering that is not set up yet shows the Support button',async()=>{
 for(const response of [{status:'unavailable'},{status:'something-new'},{status:'ready'}]){
  const f=fixture(response);await f.open();const html=f.tools.innerHTML;
  assert.match(html,/Reader ordering is not available yet\./);
  assert.match(html,/<button type="button" data-support-tickets>Support<\/button>/);
  assert.doesNotMatch(html,/Order a reader|card-reader-shop/);
  assert.equal(f.scripts.length,0);
 }
});
test('ready practice loads Connect.js from the documented address and starts it with the returned values',async()=>{
 const f=fixture();await f.open();const html=f.tools.innerHTML;
 assert.equal(f.scripts.length,1);assert.equal(f.scripts[0].tag,'script');
 assert.equal(f.scripts[0].src,'https://connect-js.stripe.com/v1.0/connect.js');assert.equal(f.scripts[0].async,true);
 assert.equal(f.log.instances.length,1);const instance=f.log.instances[0];
 assert.equal(instance.options.publishableKey,'pk_test_synthetic');
 assert.equal(await instance.options.fetchClientSecret(),'accs_secret__synthetic','the first secret is the one the server just returned');
 assert.equal(f.calls.length,1,'no second request for the first secret');
 assert.deepEqual(instance.created.map(e=>e.name),['terminal-hardware-shop','terminal-hardware-orders']);
 assert.match(html,/<h3>Order a reader<\/h3><div id="card-reader-shop"><\/div>/);
 assert.match(html,/<h3>Your orders<\/h3><div id="card-reader-orders"><\/div>/);
 assert.ok(html.indexOf('Readers are ordered from Stripe')<html.indexOf('Order a reader')&&html.indexOf('Order a reader')<html.indexOf('Your orders'));
 assert.deepEqual(f.nodes['card-reader-shop'].children,[instance.created[0]]);
 assert.deepEqual(f.nodes['card-reader-orders'].children,[instance.created[1]]);
 assert.doesNotMatch(html,/accs_secret|pk_test_/,'keys are handed to Stripe, never written into the page');
 // Stripe asks again when a long visit outlasts the first secret.
 f.context.response={...ready,client_secret:'accs_secret__second'};
 assert.equal(await instance.options.fetchClientSecret(),'accs_secret__second');assert.equal(f.calls.length,2);
 f.context.response={status:'not_connected'};await assert.rejects(instance.options.fetchClientSecret());
 f.context.response={...ready,publishable_key:'pk_test_other'};await assert.rejects(instance.options.fetchClientSecret());
});
test('light and dark themes pass matching colours and follow a theme change',async()=>{
 let f=fixture();await f.open();let variables=f.log.instances[0].options.appearance.variables;
 assert.equal(variables.colorBackground,'#ffffff');assert.equal(variables.colorText,'#233541');assert.equal(variables.colorPrimary,'#126d77');
 f.context.document.documentElement.dataset.theme='dark';for(const handler of f.handlers['suncharts:theme-change'])handler({detail:{theme:'dark'}});
 assert.equal(f.log.instances[0].updates.length,1);assert.equal(f.log.instances[0].updates[0].appearance.variables.colorBackground,'#142630');assert.equal(f.log.instances[0].updates[0].appearance.variables.colorText,'#e4edf2');
 f=fixture();f.context.document.documentElement.dataset.theme='dark';await f.open();variables=f.log.instances[0].options.appearance.variables;
 assert.equal(variables.colorBackground,'#142630');assert.equal(variables.buttonPrimaryColorText,'#10282d');
 const names=f.run('Object.keys(cardReaderPalettes.light).join()');assert.equal(names,f.run('Object.keys(cardReaderPalettes.dark).join()'));
 for(const value of Object.values(variables))assert.match(value,/^#[0-9a-f]{6}$/);
});
test('reopening reuses the one Stripe instance and a finished checkout redraws the order list',async()=>{
 const f=fixture();await f.open();await f.open();
 assert.equal(f.scripts.length,1,'the script is requested once');assert.equal(f.log.instances.length,1);
 const instance=f.log.instances[0];assert.equal(instance.created.length,4);assert.equal(instance.loggedOut,0);
 const shop=instance.created[2];shop.checkoutFinished();
 assert.equal(instance.created.length,5);assert.equal(instance.created[4].name,'terminal-hardware-orders');
 assert.deepEqual(f.nodes['card-reader-orders'].children,[instance.created[4]]);
 shop.loadError({error:{type:'api_error',message:'private detail'}});shop.loadError({error:{type:'api_error'}});
 assert.match(f.nodes['card-reader-status'].innerHTML,/Reader ordering could not load\. Try again\./);
 assert.doesNotMatch(f.nodes['card-reader-status'].innerHTML,/private detail/);
 assert.match(f.nodes['card-reader-status'].innerHTML,/<button type="button" data-card-readers>Try again<\/button>/);
});
test('signing out ends the Stripe sign-in and the next owner gets a new one',async()=>{
 const f=fixture();await f.open();const first=f.log.instances[0];
 f.run('clearCardReadersSession()');assert.equal(first.loggedOut,1);
 await assert.rejects(first.options.fetchClientSecret().then(()=>first.options.fetchClientSecret()),/Sign in again/);
 f.context.me={role:'owner',tenant_id:'tenant-b',user_id:'owner-b'};await f.open();
 assert.equal(f.log.instances.length,2);assert.equal(f.scripts.length,1);
});
test('only the practice owner can open the page and the entry is hidden from other staff',async()=>{
 const f=fixture();assert.match(f.run('renderCardReadersAdminEntry()'),/<button type="button" data-card-readers>Card readers<\/button>/);
 for(const role of ['clinician','front_desk','read_only']){f.context.me={role};assert.equal(f.run('renderCardReadersAdminEntry()'),'');await assert.rejects(f.open(),/Only the practice owner can order card readers\./);}
 assert.equal(f.calls.length,0);assert.equal(f.scripts.length,0);
});
test('a failed request or a blocked script shows a retry instead of a stuck page',async()=>{
 let f=fixture();f.context.response=()=>{const error=new Error('Reader ordering could not be opened. Try again in a few minutes.');error.status=400;throw error;};
 await f.open();assert.match(f.tools.innerHTML,/Reader ordering could not be opened\. Try again in a few minutes\./);assert.match(f.tools.innerHTML,/data-card-readers>Try again/);
 f=fixture();f.context.response=()=>{throw new Error('Connection interrupted. This change may have saved. Reload the patient before trying again.');};
 await f.open();assert.match(f.tools.innerHTML,/Check your connection and try again\./);assert.doesNotMatch(f.tools.innerHTML,/Reload the patient/);
 f=fixture();f.context.response=()=>{const error=new Error('forbidden');error.status=403;throw error;};await assert.rejects(f.open(),/forbidden/);
 f=fixture();f.context.autoLoad=false;const opening=f.run('openCardReaders()');await new Promise(r=>setImmediate(r));f.scripts[0].onerror();await opening;
 assert.match(f.tools.innerHTML,/Reader ordering could not load\. Try again\./);assert.equal(f.scripts[0].removed,true);
 f.context.autoLoad=true;f.context.response=ready;await f.open();assert.equal(f.scripts.length,2,'Try again requests the script again');assert.equal(f.log.instances.length,1);
 f=fixture();f.context.autoLoad=false;const stalled=f.run('openCardReaders()');await new Promise(r=>setImmediate(r));assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,20000);f.timers[0].fn();await stalled;
 assert.match(f.tools.innerHTML,/Reader ordering could not load\. Try again\./,'a stalled download does not leave the workspace busy');
 f=fixture();await f.open();assert.equal(f.timers[0].cleared,true);
});
test('a slow answer cannot draw over another screen or another staff member',async()=>{
 let f=fixture(),pending=deferred();f.context.response=()=>pending.promise;let opening=f.run('openCardReaders()');
 f.tools.innerHTML='<section>Schedule</section>';pending.resolve(ready);await opening;
 assert.equal(f.tools.innerHTML,'<section>Schedule</section>');assert.equal(f.scripts.length,0);
 f=fixture();pending=deferred();f.context.response=()=>pending.promise;opening=f.run('openCardReaders()');
 f.context.me={role:'owner',tenant_id:'tenant-b',user_id:'other'};pending.resolve(ready);await opening;
 assert.doesNotMatch(f.tools.innerHTML,/card-reader-shop/);assert.equal(f.log.instances.length,0);
});
test('the page still opens when the browser rewrites the page text it reports',async()=>{
 // Browsers report <button data-x> as <button data-x="">, so the page must not compare its own text.
 let f=fixture(ready,true);await f.open();assert.match(f.tools.innerHTML,/data-payment-settings=""/);assert.equal(f.log.instances.length,1);assert.equal(f.nodes['card-reader-shop'].children.length,1);
 f=fixture({status:'not_connected'},true);await f.open();assert.match(f.tools.innerHTML,/Finish payment setup before ordering a reader\./);
});
test('the button opens the page and visible wording stays plain',async()=>{
 const f=fixture();let prevented=0;
 for(const handler of f.handlers.click)handler({target:{closest:selector=>selector==='button[data-card-readers]'?{}:null},preventDefault(){prevented++;}});
 await new Promise(r=>setImmediate(r));f.loadStripe();await f.context.pending;assert.equal(prevented,1);assert.match(f.tools.innerHTML,/card-reader-shop/);
 for(const handler of f.handlers.click)handler({target:{closest:()=>null},preventDefault(){prevented++;}});assert.equal(prevented,1);
 const pages=[f.tools.innerHTML];
 for(const response of [{status:'not_connected'},{status:'unavailable'}]){const g=fixture(response);await g.open();pages.push(g.tools.innerHTML);}
 pages.push(f.run("cardReaderPage(cardReaderFailure(cardReaderLoadFailure))"),f.run('renderCardReadersAdminEntry()'));
 for(const page of pages){const text=visibleText(page);assert.doesNotMatch(text,/embedded|component|session|connect|express|sandbox|terminal|hardware/i);assert.doesNotMatch(text,/[—–]/);}
 // Strings in the script that staff can see follow the same rule.
 const strings=[...source.matchAll(/'([^'\n]*[A-Z][a-z]+ [^'\n]*)'/g)].map(m=>m[1]).filter(s=>!s.startsWith('http'));
 assert.ok(strings.length>=5);for(const s of strings)assert.doesNotMatch(visibleText(s),/embedded|component|session|\bConnect\b|Express|sandbox|—/i,s);
});

(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+(error.stack||error.message));}}if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
