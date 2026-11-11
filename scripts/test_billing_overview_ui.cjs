// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/billing-overview.js','utf8'),billing=fs.readFileSync('web/billing.js','utf8');
assert.match(billing,/if\(!settings&&typeof renderBillingOverview==='function'\)return renderBillingOverview/);
assert.match(billing,/workspaceResourceAllowed\('claims'\)\)\?loadClaimMdConnection\(\)\.catch\(\(\)=>null\):null/);
function fixture(claims=false){
 const nodes={},calls=[],handlers={},rendered=[];
 function node(id){return nodes[id]={id,hidden:false,children:[],_html:'',set innerHTML(value){this._html=value;if(id==='tools'){delete nodes['billing-overview'];node('billing-overview');}if(id==='billing-overview'&&value.includes('billing-overview-preview')){node('billing-overview-preview');node('billing-overview-claims');}},get innerHTML(){return this._html;},append(value){this.children.push(value);if(value.id)nodes[value.id]=value;},scrollIntoView(){}};}
 node('tools');
 const data={mode:'recorded',summary:{accounts:{open_invoice_count:1,reviewed_patient_due_cents:500,invoice_review_count:1},copays:{net_received_cents:2500,receipts:1,usable_unapplied_cents:2500,review_count:0}},accounts:{items:[{id:'account',patient_id:'patient',patient_name:'Synthetic <Patient>',mrn:'MRN',service_date:'2026-11-11',status:'posted',total_cents:10000,account_balance_cents:7500,invoice_id:'invoice',invoice_due_cents:500,reviewed_responsibility_cents:3000,invoice_created_at:'2026-11-11',invoice_needs_review:true}],next_cursor:null},copays:{items:[{id:'receipt',patient_name:'Standalone Synthetic',mrn:'OTHER',occurred_on:'2026-11-11',method:'cash',amount_cents:2500,net_received_cents:2500,usable_unapplied_cents:2500}],next_cursor:null}};
 const context={console,URLSearchParams,Symbol,encodeURIComponent,me:{id:'staff',role:'front_desk'},document:{addEventListener:(kind,fn)=>handlers[kind]=fn,createElement:tag=>({tag,setAttribute(){}})},$:id=>nodes[id],workspaceResourceAllowed:resource=>resource==='billing'||resource==='claims'&&claims,showTool:title=>{context.title=title;nodes.tools.hidden=false;},money:c=>'$'+(c/100).toFixed(2),human:String,date:String,esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),invoicePaymentMethod:String,run:fn=>fn(),api:async path=>{calls.push(path);if(path.startsWith('/api/v1/billing/overview'))return data;if(path.startsWith('/api/v1/billing/claims'))return {items:[]};if(path.includes('/invoices/'))return {id:'invoice',snapshot:{}};return {receipt:{id:'receipt'},context:{patient:{given_name:'Synthetic'}}};},patientInvoiceDocument:value=>{rendered.push(value);return 'invoice HTML';},copayReceiptDocument:(value,copy)=>{rendered.push({value,copy});return 'receipt HTML';}};
 vm.createContext(context);vm.runInContext(source,context);return {context,nodes,calls,data,rendered,node};
}
(async()=>{
 let f=fixture();await f.context.renderBillingOverview();
 assert.equal(f.context.title,'Billing & insurance');assert.deepEqual(f.calls,['/api/v1/billing/overview?mode=recorded']);
 const html=f.nodes['billing-overview'].innerHTML;
 for(const value of ['Standalone Synthetic','Collected copays','Unapplied copay credit','$5.00','at issuance','Needs review','patient and insurer','No insurer attached'])assert.ok(html.includes(value),value);
 assert.ok(!html.includes('data-billing-patient'),'billing-only users are not sent into clinical chart');assert.ok(html.includes('Synthetic &lt;Patient&gt;'));assert.ok(html.includes('account containing any TEST ledger activity'));
 assert.ok(f.nodes['billing-overview'].innerHTML.includes('Claim information is not available to this role'));
 await f.context.showBillingOverviewDocument('invoice','invoice');await f.context.showBillingOverviewDocument('receipt','receipt');
 assert.deepEqual(f.calls.slice(1),['/api/v1/billing/invoices/invoice','/api/v1/billing/copay-receipts/receipt']);assert.equal(f.rendered.length,2);assert.equal(f.nodes['billing-overview-preview'].children.length,2);
 f=fixture(true);const original=f.context.api;f.context.api=async path=>{if(path.includes('/claims'))throw Error('denied');return original(path);};await f.context.renderBillingOverview();await new Promise(setImmediate);
 assert.ok(f.nodes['billing-overview-claims'].innerHTML.includes('remain available'));assert.ok(f.nodes['billing-overview'].innerHTML.includes('Standalone Synthetic'));
 f=fixture();let complete;f.context.api=()=>new Promise(resolve=>complete=resolve);const pending=f.context.renderBillingOverview();const prior=f.nodes['billing-overview'];f.nodes.tools.hidden=true;complete(f.data);await pending;assert.ok(prior.innerHTML.includes('Loading')||prior.innerHTML==='','late response cannot reopen another workspace');
 f=fixture();let first,second;f.context.api=()=>new Promise(resolve=>{if(!first)first=resolve;else second=resolve;});const a=f.context.renderBillingOverview(),b=f.context.renderBillingOverview(null,null,{mode:'test'});second({...f.data,mode:'test'});await b;first(f.data);await a;assert.ok(f.nodes['billing-overview'].innerHTML.includes('TEST activity'));
 f=fixture();await f.context.renderBillingOverview();let done;f.context.api=()=>new Promise(resolve=>done=resolve);const doc=f.context.showBillingOverviewDocument('invoice','invoice');f.context.me={id:'another'};done({id:'invoice',snapshot:{}});await doc;assert.equal(f.rendered.length,0,'another session cannot receive the prior document');
 f=fixture();await f.context.renderBillingOverview();await f.context.renderBillingOverview(null,null,{accountsAfter:'account-page2',preserveOther:true});await f.context.renderBillingOverview(null,null,{copaysAfter:'receipt-page2',preserveOther:true});
 assert.ok(f.calls.at(-1).includes('accounts_after=account-page2'));assert.ok(f.calls.at(-1).includes('copays_after=receipt-page2'));assert.ok(f.nodes['billing-overview'].innerHTML.includes('First accounts page'));assert.ok(f.nodes['billing-overview'].innerHTML.includes('First receipts page'));
 await f.context.renderBillingOverview(null,null,{accountsAfter:null,preserveOther:true});assert.ok(!f.calls.at(-1).includes('accounts_after='));assert.ok(f.calls.at(-1).includes('copays_after=receipt-page2'));
 await f.context.renderBillingOverview(null,null,{mode:'test'});assert.ok(!f.calls.at(-1).includes('_after='),'mode change resets both cursors');
 f.context.me={id:'new-staff',role:'front_desk'};await f.context.renderBillingOverview();assert.equal(f.calls.at(-1),'/api/v1/billing/overview?mode=recorded','new session never inherits prior paging or test view');
 // Existing tools filters and pagination must stay in the tools worklist.
 const listeners={},toolCalls=[],tools={console,Intl,me:{role:'owner'},document:{addEventListener:(event,handler)=>(listeners[event]??=[]).push(handler)},window:{addEventListener(){}},run:fn=>tools.pending=fn(),FormData:class{*[Symbol.iterator](){yield ['status','posted'];}}};
 vm.createContext(tools);vm.runInContext(billing,tools);tools.showBillingQueue=async(...args)=>toolCalls.push(args);
 for(const handler of listeners.change||[])handler({target:{closest:selector=>selector==='#billing-filter select[name="status"]'?{value:'posted'}:null}});
 await tools.pending;assert.deepEqual(toolCalls.pop(),['posted',undefined,true]);
 function click(attribute){const button={dataset:{},type:'button',closest:selector=>selector==='#billing-tool'?{}:null,hasAttribute:name=>name===attribute};for(const handler of listeners.click||[])handler({target:{closest:selector=>selector==='button'?button:null},preventDefault(){}});return tools.pending;}
 await click('data-billing-refresh');assert.equal(toolCalls.pop()[2],true);
 await click('data-billing-next');assert.equal(toolCalls.pop()[2],true);
 await click('data-billing-overview');assert.deepEqual(toolCalls.pop(),[]);
 const setupNodes={tools:{innerHTML:''}},setupCalls=[];let setupPermissions=false;
 const setup={console,Intl,URLSearchParams,me:{role:'front_desk'},document:{addEventListener(){}},window:{addEventListener(){}},$:id=>setupNodes[id],showTool(){},esc:String,human:String,workspaceResourceAllowed:resource=>resource==='billing'||setupPermissions,api:async path=>{setupCalls.push(path);return path.includes('/worklist')?{items:[{id:'account',patient_id:'patient',patient_name:'Synthetic',mrn:'MRN',service_date:'2026-11-11',status:'posted',total_cents:10000,balance_cents:7500}],next_cursor:null}:{items:[]};},loadClaimMdConnection:async()=>{setupCalls.push('claims status');return {};},claimmdPayerDirectoryPanel:()=>'<div>CLAIMMD-PAYER-SEARCH</div>'};
 vm.createContext(setup);vm.runInContext(billing,setup);await setup.showBillingQueue('',undefined,true);
 assert.ok(setupNodes.tools.innerHTML.includes('Payer directory'));assert.ok(!setupNodes.tools.innerHTML.includes('data-billing-patient'));assert.ok(!setupNodes.tools.innerHTML.includes('CLAIMMD-PAYER-SEARCH'));assert.ok(!setupCalls.includes('claims status'));
 setupPermissions=true;await setup.showBillingQueue('',undefined,true);assert.ok(setupNodes.tools.innerHTML.includes('data-billing-patient'));assert.ok(setupNodes.tools.innerHTML.includes('CLAIMMD-PAYER-SEARCH'));
 console.log('PASS native overview: standalone receipts, billing-only direct previews, independent claims, escaped data, and stale navigation/session responses');
})().catch(error=>{console.error(error);process.exitCode=1;});
