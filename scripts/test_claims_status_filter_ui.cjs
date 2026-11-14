// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
// Staff display helpers load before every feature script, exactly as index.html loads them.
{const createContext=vm.createContext;vm.createContext=(...args)=>{const context=createContext(...args);vm.runInContext(require('fs').readFileSync('web/display-format.js','utf8'),context);return context;};}

const claims=[
 {id:'c1',patient_name:'Adams, Ana',control_number:'SYN-1',payer_name:'Synthetic Payer',frequency:'original',status:'draft',total_cents:12000},
 {id:'c2',patient_name:'Brown, Bo',control_number:'SYN-2',payer_name:'Synthetic Payer',frequency:'original',status:'ready',total_cents:9000},
 {id:'c3',patient_name:'Brown, Bo',control_number:'SYN-3',payer_name:'Synthetic Payer',frequency:'replacement',status:'submitted',total_cents:9000},
 {id:'c4',patient_name:'Cruz, Cal',control_number:'SYN-4',payer_name:'Synthetic Payer',frequency:'original',status:'rejected',total_cents:15000},
 {id:'c5',patient_name:'Diaz, Di',control_number:'SYN-5',payer_name:'Synthetic Payer',frequency:'original',status:'adjudicated',total_cents:22000},
 {id:'c6',patient_name:'Diaz, Di',control_number:'SYN-6',payer_name:'Synthetic Payer',frequency:'original',status:'adjudicated',total_cents:8000},
 {id:'c7',patient_name:'Evans, Ed',control_number:'SYN-7',payer_name:'Synthetic Payer',frequency:'original',status:'void',total_cents:5000}
];
const counts={draft:12,ready:3,submitted:5,accepted:0,rejected:2,adjudicated:40,void:1};

function fixture(){
 const handlers={},nodes=new Map(),calls=[];let claimPage=claims,countsResponse={counts};
 // The two views below are the claims table body and the chip strip. Writing to one
 // rewrites that part of the workspace, the way replacing a node does in the page.
 const claimsMarkup=()=>String(nodes.get('tools')?.innerHTML||'');
 // These two views are the claims table body and the chip strip. Writing to one rewrites
 // that part of the workspace, the way replacing a node does in the page.
 const body={get innerHTML(){return String(claimsMarkup().match(/<tbody data-claim-rows>([\s\S]*?)<\/tbody>/)?.[1]||'');},set innerHTML(rows){nodes.get('tools').innerHTML=claimsMarkup().replace(/<tbody data-claim-rows>[\s\S]*?<\/tbody>/,`<tbody data-claim-rows>${rows}</tbody>`);}};
 const stripView={get outerHTML(){return String(claimsMarkup().match(/<nav[^>]*claims-status-strip[\s\S]*?<\/nav>/)?.[0]||'');},set outerHTML(markup){nodes.get('tools').innerHTML=claimsMarkup().replace(/<nav[^>]*claims-status-strip[\s\S]*?<\/nav>/,markup);}};
 const node=id=>{const item={id,innerHTML:'',dataset:{},values:{},hidden:false,scrollIntoView(){},querySelector(selector){if(selector==='[data-claim-rows]')return body;if(selector==='.claims-status-strip')return stripView;return null;},querySelectorAll(){return [];},insertAdjacentHTML(){}};nodes.set(id,item);return item;};
 const ctx={console,Map,JSON,Date,Error,crypto:{randomUUID:()=>'synthetic-request'},document:{addEventListener:(type,fn)=>(handlers[type]??=[]).push(fn),querySelector:()=>null},$:node,me:{user_id:'clinician',role:'owner'},selected:null,chartSection:null,activeVisit:null,billingPayers:[],window:{},esc:v=>String(v??''),human:v=>String(v),date:v=>String(v),money:v=>`$${v}`,displayDate:v=>String(v),billingWrite:()=>true,notice:()=>{},showTool:()=>{},run:fn=>ctx.pending=fn(),loadClaimMdConnection:async()=>({configured:false,connected:false}),claimMdConnectionCard:()=>'',showEraAutomation:async()=>{},showRecoupments:async()=>{},showEraBatches:async()=>{},async api(path){calls.push(path);
  if(path==='/api/v1/billing/claims')return {items:claimPage,next_cursor:null};
  if(path==='/api/v1/billing/claims/status-counts')return typeof countsResponse==='function'?countsResponse():countsResponse;
  if(path==='/api/v1/billing/payers')return {items:[]};
  if(path==='/api/v1/billing/remittances')return {items:[],next_cursor:null};
  if(path==='/api/v1/billing/remittance-sources')return {items:[]};
  throw new Error('Unexpected API '+path);
 }};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/claims.js','utf8'),ctx);
 const workspace=claimsMarkup;
 const strip=()=>String(workspace().match(/<nav[^>]*claims-status-strip[\s\S]*?<\/nav>/)?.[0]||'');
 const rows=()=>String(workspace().match(/<tbody data-claim-rows>([\s\S]*?)<\/tbody>/)?.[1]||'');
 const chip=(status,label,amount,pressed)=>{const chipMarkup=`data-claim-status="${status}" aria-pressed="${pressed}">${label}<span>${amount}</span>`;assert.ok(strip().includes(chipMarkup),`chip ${status} should read "${label} ${amount}" with aria-pressed=${pressed} in:\n${strip()}`);};
 const load=(...args)=>ctx.showClaimsWorkspace(...args);
 const click=async status=>{for(const handler of handlers.click)handler({target:{closest:selector=>selector==='#claims-tool [data-claim-status]'?{dataset:{claimStatus:status}}:null},preventDefault(){}});await ctx.pending;};
 return {ctx,calls,workspace,strip,rows,chip,load,click,setPage:page=>claimPage=page,setCounts:value=>countsResponse=value};
}
(async()=>{
 const f=fixture();await f.load();
 assert.equal(f.calls.filter(path=>path==='/api/v1/billing/claims/status-counts').length,1,'the counts endpoint is fetched with the list');
 for(const [status,label,amount] of [['all','All',7],['draft','Draft',12],['ready','Ready to send',3],['submitted','Sent',5],['accepted','Accepted',0],['rejected','Rejected',2],['adjudicated','Adjudicated',40],['void','Voided',1]])f.chip(status,label,amount,status==='all');
 assert.match(f.strip(),/aria-label="Filter claims by status"/);
 assert.doesNotMatch(f.strip(),/>Paid</);assert.doesNotMatch(f.strip(),/>Denied</);
 assert.equal((f.rows().match(/SYN-/g)||[]).length,7,'All lists every loaded claim');
 assert.match(f.workspace(),/class="muted claim-filter-note"/,'staff are told the counts cover every claim');

 await f.click('adjudicated');
 assert.equal(f.ctx.claimStatusFilter,'adjudicated');
 f.chip('adjudicated','Adjudicated',40,true);f.chip('all','All',7,false);
 assert.equal((f.rows().match(/SYN-/g)||[]).length,2);
 assert.doesNotMatch(f.rows(),/SYN-1/);assert.match(f.rows(),/SYN-5/);assert.match(f.rows(),/SYN-6/);

 await f.click('void');assert.equal((f.rows().match(/SYN-/g)||[]).length,1);assert.match(f.rows(),/SYN-7/);
 await f.click('accepted');assert.equal((f.rows().match(/SYN-/g)||[]).length,0);
 assert.match(f.rows(),/No claims here with this status\. Choose All to see every claim\./,'the empty row tells staff what to do next');
 await f.click('all');assert.equal((f.rows().match(/SYN-/g)||[]).length,7);

 // A chip click filters what is already loaded: it is not a refresh and fetches nothing.
 const calls=f.calls.length;await f.click('ready');
 assert.equal(f.calls.length,calls,'filtering reuses the loaded page');
 assert.equal((f.rows().match(/SYN-/g)||[]).length,1);assert.match(f.rows(),/SYN-2/);
 assert.match(f.rows(),/Open claim/,'a filtered row still opens its claim');

 // Reopening the list resets the selection but keeps the tenant-wide counts.
 await f.click('draft');await f.load();
 assert.equal(f.ctx.claimStatusFilter,'all');
 assert.equal((f.rows().match(/SYN-/g)||[]).length,7);
 f.chip('all','All',7,true);f.chip('draft','Draft',12,false);

 // Counts cover the whole practice, so a status only present on a later page still counts.
 const paged=fixture();paged.setPage(claims.slice(0,3));await paged.load();
 paged.chip('adjudicated','Adjudicated',40,false);paged.chip('all','All',3,true);

 // The loaded page is a floor for a chip: a missing count never reads zero with rows shown.
 const missing=fixture();missing.setCounts({});await missing.load();
 missing.chip('all','All',7,true);missing.chip('draft','Draft',1,false);missing.chip('adjudicated','Adjudicated',2,false);
 await missing.click('draft');assert.equal((missing.rows().match(/SYN-/g)||[]).length,1);

 // An unusable counts response degrades to the loaded page instead of breaking the list.
 const broken=fixture();broken.setCounts(()=>{throw new Error('counts endpoint unavailable');});await broken.load();
 broken.chip('draft','Draft',1,false);assert.equal((broken.rows().match(/SYN-/g)||[]).length,7);

 // An unknown stored status stays under All and cannot become a selected chip.
 const unknown=fixture();unknown.setPage([...claims,{id:'c8',patient_name:'Fox, Fi',control_number:'SYN-8',payer_name:'Synthetic Payer',frequency:'original',status:'future_state',total_cents:100}]);await unknown.load();
 unknown.chip('all','All',8,true);assert.doesNotMatch(unknown.strip(),/data-claim-status="future_state"/);
 await unknown.click('future_state');assert.equal(unknown.ctx.claimStatusFilter,'all','an unknown status falls back to All');
 assert.equal((unknown.rows().match(/SYN-/g)||[]).length,8);
 console.log('PASS claim status chips show a count per status from the tenant-wide counts endpoint, filter the list on click with All as the default, reset on reload and stay usable when counts are missing');
})().catch(error=>{console.error(error);process.exitCode=1;});
