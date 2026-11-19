// SPDX-License-Identifier: AGPL-3.0-only
// The practice address prompt on the card reader screen: it opens when the payments service has
// no address, and its "Add reader" resends the same reader with the address typed into the form.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/card-readers.js','utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const listed=(readers=[],extra={})=>({status:'ready',readers,can_manage:true,payments_available:true,...extra});
const refusal=(message,status,code)=>{const error=new Error(message);error.status=status;if(code)error.code=code;return error;};
const missingAddress=()=>refusal('Enter the practice address to finish adding the reader.',409,'practice_address_missing');
function fixture(readers=[]){
 const host=id=>({id,children:[],appendChild(child){this.children.push(child);},replaceChildren(...children){this.children=children;}});
 const nodes={};
 const tools={hidden:false,_html:'',get innerHTML(){return this._html;},set innerHTML(value){this._html=value;for(const id of ['card-reader-shop','card-reader-orders','card-reader-status','card-reader-list'])if(value.includes(`id="${id}"`))nodes[id]=host(id);else delete nodes[id];}};
 nodes.tools=tools;
 const readerCalls=[],notices=[],docHandlers={},log=[];
 // The dialog host is the one web/dialog.js creates; only enough of it is stood in for here.
 const dialog={id:'suncharts-dialog-host',hidden:true,_html:'',children:[],get innerHTML(){return this._html;},
  set innerHTML(value){this._html=value;},querySelector:selector=>selector==='input[name="line1"]'?{focus(){log.push('focus line1');}}:null};
 const context={console,Promise,setTimeout:()=>0,clearTimeout:()=>{},me:{role:'owner',tenant_id:'tenant',user_id:'owner'},$:id=>nodes[id]||null,esc,
  api:async(...args)=>{if(String(args[0]).startsWith('/api/v1/billing/payments/readers')&&!String(args[0]).endsWith('/hardware-session')){readerCalls.push(args);return typeof context.readers==='function'?context.readers(...args):context.readers;}if(String(args[0]).endsWith('/hardware-session'))return context.session;return {status:'ready'};},
  readers:listed(readers),session:{status:'unavailable'},crypto:{randomUUID:()=>'request-'+(++context.uuids)},uuids:0,notice:(...args)=>notices.push(args),money:n=>`$${(n/100).toFixed(2)}`,
  FormData:class{constructor(form){return Object.entries(form.values)[Symbol.iterator]();}},
  showTool:title=>{context.page=title;},run:async fn=>{
   // The app's own run() reports a refused action as a notice instead of throwing to the caller.
   const pending=fn();context.pending=Promise.resolve(pending).catch(error=>{notices.push([error.message,true]);});
   return context.pending;},window:{}};
 context.document={documentElement:{dataset:{theme:'light'}},head:{appendChild:()=>{}},createElement:tag=>({tag,remove(){this.removed=true;}}),
  getElementById:id=>id==='suncharts-dialog-host'?dialog:null,body:{append:child=>{dialog.isConnected=true;}},
  addEventListener:(type,fn,options)=>{(docHandlers[type]??=[]).push({fn,capture:options===true});},removeEventListener:(type,fn)=>{const list=docHandlers[type]||[];const at=list.findIndex(item=>item.fn===fn);if(at>=0)list.splice(at,1);}};
 context.window.window=context;
 vm.createContext(context);vm.runInContext(source,context);
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 // Every submit and click is dispatched the way the page's own listeners receive it: the capture
 // listener the address form installs runs before the screen's listener, as it does in a browser.
 const dispatch=(type,event)=>{for(const {fn,capture} of [...docHandlers[type]].sort((a,b)=>Number(!!b.capture)-Number(!!a.capture)))fn(event);return context.pending;};
 const submit=form=>dispatch('submit',{target:form,preventDefault(){},stopPropagation(){}});
 const click=dataset=>dispatch('click',{target:{closest:selector=>selector==='button'||selector==='button,[data-address-cancel]'?{dataset,hasAttribute:name=>name in dataset}:null},preventDefault(){},stopPropagation(){}});
 // The add request carries the refusal the payments service gives when the account has no address.
 const refuseAdds=()=>{context.readers=(...args)=>{if(args[1]==='POST')throw missingAddress();return listed(readers);};};
 // The screen is open with its own add form showing, then the owner submits it.
 const openPrompt=async(values={code:' sepia-cerulean-aqua ',name:' Front desk '})=>{
  refuseAdds();
  await openPage();
  vm.runInContext("openCardReaderForm('add')",context);
  await submit({id:'card-reader-add-form',dataset:{},values});
  return dialog._html;
 };
 const openPage=async()=>{
  try{await vm.runInContext('openCardReaders()',context);}catch{}
  // Everything the opening scheduled is let to settle, so a refusal left by the page's own reader
  // list cannot be mistaken for one this test produced.
  for(let step=0;step<8;step++){
   await tick();
   if(context.pending)await Promise.resolve(context.pending).catch(()=>{});
   await tick();
  }
 };
 return {context,nodes,tools,dialog,readerCalls,notices,openPrompt,openPage,refuseAdds,submit,click,tick,run:code=>vm.runInContext(code,context)};
}
const same=(actual,expected)=>assert.equal(JSON.stringify(actual),JSON.stringify(expected));
const tests=[];const test=(name,fn)=>tests.push([name,fn]);

test('the address prompt opens where the reader was being added',async()=>{
 const f=fixture();const html=await f.openPrompt();
 assert.equal(f.dialog.hidden,false,'the prompt is on screen');
 assert.match(html,/aria-modal="true"/);assert.match(html,/>Practice address<\/h2>/);
 assert.match(html,/id="card-reader-address-form"/);
 for(const label of ['Street address','Suite or unit (optional)','City','State','ZIP'])assert.ok(html.includes(`>${label}<input`),label);
 assert.match(html,/<button type="submit" class="primary">Add reader<\/button><button type="button" data-address-cancel>Cancel<\/button>/);
 assert.match(html,/We need the practice address before the reader can be added\./);
 assert.match(html,/Practice administration, Facilities/,'staff are told where else the address can be kept');
 assert.equal(f.readerCalls.filter(call=>call[1]==='POST').length,1,'the prompt is asked for once, not on a loop');
});
test('Add reader resends the same reader with the typed address and a new request',async()=>{
 const f=fixture();await f.openPrompt();f.readerCalls.length=0;
 f.context.readers=(...args)=>args[1]==='POST'?{reader:{id:'tmr_new',name:'Front desk',model:'Stripe Reader S700',online:true,busy:false}}:listed([{id:'tmr_new',name:'Front desk',model:'Stripe Reader S700',online:true,busy:false}]);
 await f.submit({id:'card-reader-address-form',values:{line1:' 100 Example St ',line2:' Suite 4 ',city:' Austin ',state:' tx ',postal_code:' 78701-1234 '}});
 assert.equal(f.readerCalls.length,1);const [path,method,body]=f.readerCalls[0];
 assert.equal(path,'/api/v1/billing/payments/readers');assert.equal(method,'POST');
 assert.equal(body.code,'sepia-cerulean-aqua','the same reader code');assert.equal(body.name,'Front desk','the same reader name');
 assert.equal(body.request_id,'request-2','a new request, not the one already refused');
 same(body.location_address,{line1:'100 Example St',line2:'Suite 4',city:'Austin',state:'TX',postal_code:'78701-1234'});
 assert.equal(f.dialog.hidden,true,'the prompt closes when the reader is added');
 assert.deepEqual(f.notices.at(-1),['Reader added.']);
});
test('an error inside the prompt stays inside the prompt',async()=>{
 const f=fixture();await f.openPrompt();f.readerCalls.length=0;f.notices.length=0;
 f.context.readers=(...args)=>{if(args[1]==='POST')throw refusal('Enter the 5-digit ZIP code.',400);return listed([]);};
 await f.submit({id:'card-reader-address-form',values:{line1:'100 Example St',line2:'',city:'Austin',state:'TX',postal_code:'7870'}});
 assert.equal(f.dialog.hidden,false,'the prompt stays open for another try');
 assert.match(f.dialog._html,/>Enter the 5-digit ZIP code\.</);
 assert.match(f.dialog._html,/value="100 Example St"/,'what staff typed is kept');
 assert.deepEqual(f.notices,[],'a refusal inside the prompt is never reported behind it');
 f.context.readers=(...args)=>args[1]==='POST'?{reader:{id:'tmr_new',name:'Front desk',model:'Stripe Reader S700',online:true,busy:false}}:listed([]);
 await f.submit({id:'card-reader-address-form',values:{line1:'100 Example St',line2:'',city:'Austin',state:'TX',postal_code:'78701'}});
 assert.equal(f.readerCalls.length,2,'the second try is sent again with a new request');
 assert.equal(f.readerCalls[1][2].request_id,'request-3');
 assert.equal(f.dialog.hidden,true);assert.deepEqual(f.notices.at(-1),['Reader added.']);
});
test('Cancel closes the prompt and sends nothing',async()=>{
 const f=fixture();await f.openPrompt();f.readerCalls.length=0;
 await f.click({addressCancel:''});
 assert.equal(f.dialog.hidden,true);assert.equal(f.readerCalls.length,0);assert.deepEqual(f.notices,[]);
});
test('another conflict is not turned into an address prompt',async()=>{
 const f=fixture();await f.openPage();
 // The page swallows a load failure, so the form is opened by hand and only its submits are watched.
 vm.runInContext("cardReaderListState={data:readers,failed:false,form:cardReaderAddFormMarkup({})}",f.context);
 // The screen's own run() reports a refusal as a notice; nothing else may answer for it.
 f.context.readers=(...args)=>{if(args[1]==='POST')throw refusal('That code was not accepted. Check the code on the reader and try again.',400);return listed([]);};
 await f.submit({id:'card-reader-add-form',dataset:{},values:{code:'wrong-code',name:'Front desk'}});await f.tick();
 assert.deepEqual(f.notices.at(-1),['That code was not accepted. Check the code on the reader and try again.',true]);
 assert.equal(f.dialog.hidden,true,'no prompt for an unrelated refusal');
 f.context.readers=(...args)=>{if(args[1]==='POST')throw refusal('Enter the practice address to finish adding the reader.',409);return listed([]);};
 await f.submit({id:'card-reader-add-form',dataset:{},values:{code:'again',name:'Front desk'}});await f.tick();
 assert.deepEqual(f.notices.at(-1),['Enter the practice address to finish adding the reader.',true]);
 assert.equal(f.dialog.hidden,true,'a conflict without the code is left alone');
});
test('the address form and its wording stay plain',async()=>{
 const f=fixture();await f.openPrompt();
 const text=f.dialog._html.replace(/<[^>]*>/g,' ');
 assert.doesNotMatch(text,/payload|request_id|server|intent|terminal|simulated|schema/i,text);
 assert.doesNotMatch(text,/[—–]/);
});

(async()=>{let failed=0;for(const [name,fn] of tests){try{await fn();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name+'\n'+(error.stack||error.message));}}if(failed)process.exitCode=1;})().catch(error=>{console.error(error);process.exitCode=1;});
