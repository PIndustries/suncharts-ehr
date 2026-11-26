// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function harness({failSync}){
  const calls=[],notices=[],clicks={};let html='';
  const context={
    console,Date,JSON,crypto:{randomUUID:()=>'request-synthetic'},
    esc:escape,date:value=>String(value),
    document:{addEventListener:(kind,fn)=>{clicks[kind]=fn;}},
    api:async(path,method,body)=>{
      calls.push({path,method,body});
      if(failSync&&path.endsWith('/notes/sync'))throw Object.assign(new Error('Claim.MD note cursor is invalid'),{status:400});
      if(path.endsWith('/operations'))return {records:[{kind:'modification',remote_id:'9001',claimmd_id:'135961467',recorded_at:'2026-11-02T10:00:00Z',content:{field:'ins_name_l'}}],transmitted_files:[]};
      return {};
    },
    notice:(message,error)=>notices.push({message,error:!!error}),
    run:async action=>{await action();},
    showTool:()=>{},showEdiWorkspace:async()=>{},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('web/claimmd-operations.js','utf8'),context);
  context.$=()=>({set innerHTML(v){html=v;},get innerHTML(){return html;}});
  return {context,calls,notices,clicks,html:()=>html};
}

(async()=>{
 // The activity screen lists changes and notes with plain headings.
 const f=harness({failSync:false});
 await f.context.showClaimMdOperations('setting-1');
 assert.match(f.html(),/Changes and notes made in the clearinghouse/);
 assert.match(f.html(),/Nothing here yet\./,'a connection with no notes says so in plain words');

 // A failing notes refresh keeps the screen, keeps the changes and shows plain words.
 const g=harness({failSync:true});
 await g.context.showClaimMdOperations('setting-1');
 g.clicks.click({target:{closest:()=>({dataset:{claimmdSync:'notes'},hasAttribute:()=>false})},preventDefault(){},stopImmediatePropagation(){}});
 await new Promise(resolve=>setImmediate(resolve));
 const shown=g.notices.at(-1);
 assert.ok(shown,'the failure is reported');
 assert.equal(shown.error,true);
 assert.doesNotMatch(shown.message,/cursor|LastNoteID|invalid|parse|null/i,'no internal wording reaches staff');
 assert.match(shown.message,/could not be refreshed/i);
 assert.match(shown.message,/unchanged/i,'staff are told the list they can see is still valid');
 assert.match(g.html(),/9001/,'the changes that did arrive stay on the screen');

 // The per-claim refresh on the claim activity screen also speaks plain words.
 const ext={
   console,Date,JSON,esc:escape,human:v=>String(v),date:v=>String(v),
   me:{role:'owner'},claimMdConnectionState:{active:{id:'setting-1'}},
   document:{addEventListener:(kind,fn)=>{ext.click=fn;}},
   api:async(path)=>{if(path.endsWith('/notes/sync'))throw Object.assign(new Error('Claim.MD note cursor is invalid'),{status:400});return {}},
   notice:(message,error)=>{ext.notice={message,error:!!error};},
   run:async action=>{await action();},
   showClaim:async()=>{},
 };
 vm.createContext(ext);
 vm.runInContext(fs.readFileSync('web/claimmd-extended.js','utf8'),ext);
 ext.click({target:{closest:()=>({dataset:{claimmdClaimSync:'notes',claimmdId:'135961467',nativeClaim:'claim-1'}})},preventDefault(){},stopImmediatePropagation(){}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ext.notice.error,true);
 assert.doesNotMatch(ext.notice.message,/cursor|LastNoteID|invalid|parse|null/i);
 assert.match(ext.notice.message,/notes could not be refreshed/i);
 let finish;const reopened=[],invalidated=[],messages=[];
 const context={claim:'claim-1',detailRequest:{kind:'claim',id:'claim-1'}};
 ext.claimContextSnapshot=()=>context;ext.claimContextCurrent=v=>v===context;
 ext.api=()=>new Promise(resolve=>{finish=resolve;});ext.notice=(...args)=>messages.push(args);
 ext.showClaim=async id=>reopened.push(id);ext.invalidateClaimTimeline=id=>invalidated.push(id);
 const refresh=()=>ext.click({target:{closest:()=>({isConnected:true,dataset:{claimmdClaimSync:'notes',claimmdId:'135961467',nativeClaim:'claim-1'}})},preventDefault(){},stopImmediatePropagation(){}});
 refresh();context.detailRequest={kind:'claim',id:'claim-2'};finish();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(reopened,[]);assert.deepEqual(messages,[]);assert.deepEqual(invalidated,['claim-1']);
 context.detailRequest={kind:'claim',id:'claim-1'};refresh();finish();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(reopened,['claim-1']);assert.equal(messages.length,1);
 console.log('PASS late note refresh never reopens the previously selected claim');
 console.log('PASS Claim.MD notes and changes refreshes fail in plain words and keep the evidence already on screen');
})().catch(error=>{console.error(error);process.exitCode=1;});
