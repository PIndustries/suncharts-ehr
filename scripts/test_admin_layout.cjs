// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
// Reuse the synthetic directory fixture without running its test suite.
const existing=fs.readFileSync('scripts/test_practice_admin_ui.cjs','utf8');
const fixtureContext=vm.createContext({require,console,process});
vm.runInContext(existing.slice(0,existing.indexOf('(async()=>{')),fixtureContext);
const fixture=()=>fixtureContext.fixture();
(async()=>{
 let f=fixture();await f.run('showPracticeAdmin()');
 let html=f.element('practice-admin-panel').innerHTML;
 assert.match(html,/Admin \/ Practice \/ Practice details/);
 assert.doesNotMatch(html,/chart-tabs/);
 assert.match(html,/data-admin-refresh>Refresh directory<\/button>/);
 const groups=f.run('practiceAdminGroups');
 assert.deepEqual(Array.from(groups,([group,items])=>[group,items.length]),[['Practice',5],['People',2],['Billing',6],['Advanced',5]]);
 const destinations={details:'data-admin-tab="details"',facilities:'data-admin-tab="facilities"',rooms:'data-admin-tab="rooms"','visit-types':'data-admin-tab="visit-types"',calendar:'data-calendar-links-admin',staff:'data-admin-tab="staff"',providers:'data-admin-tab="providers"',claims:'data-go-nav="nav-edi"',organizations:'data-billing-organizations',codes:'data-terminology-manage',fees:'data-fees-manage',readers:'data-card-readers',memberships:'data-admin-tab="memberships"',integrations:'data-go-nav="nav-apps"',workflows:'data-go-nav="nav-workflows"',import:'data-go-nav="nav-migration"',partners:'data-partners-screen',workspace:'data-admin-tab="workspace"'};
 for(const [group,items] of groups)for(const [key,label,attribute] of items){
  assert.equal(attribute,destinations[key]);
  const framed=f.run(`practiceAdminFrameMarkup(${JSON.stringify(key)},'<form>synthetic content</form>')`);
  assert.match(framed,new RegExp(`Admin / ${group} / ${label.replace('&','&amp;')}`));
  assert.equal((framed.match(/aria-current="page"/g)||[]).length,1);
  assert(framed.includes(`${attribute} aria-current="page"`));
  assert(framed.includes('<form>synthetic content</form>'));
 }
 assert.equal((html.match(/class="frame-admin-status">Not done/g)||[]).length,7);
 assert.equal((html.match(/class="frame-admin-status">Done/g)||[]).length,0);
 assert.match(html,/Some setup details could not be checked/);
 assert.deepEqual(Array.from(f.requests,x=>x.path).sort(),['/api/v1/practice/staff','/api/v1/practice/providers','/api/v1/practice/facilities','/api/v1/practice/rooms','/api/v1/practice/billing-organizations','/api/v1/billing/claimmd/status','/api/v1/billing/payers','/api/v1/billing/payments/settings'].sort());
 assert(f.requests.every(x=>!x.method),'checklist only reads existing endpoints');
 console.log('PASS all 18 destinations, four supplied groups, selected item and breadcrumbs');
 f=fixture();
 f.data.providers.items=[{id:'synthetic-provider',active:true,npi:'1234567893'}];
 Object.assign(f.data.facilities.items[0],{address_line1:'1 Synthetic Street',city:'Synthetic City',state:'SY',postal_code:'10001'});
 f.replies['GET /api/v1/practice/billing-organizations']={items:[{active:true,tax_id_last4:'0001',npi:'1234567893'}]};
 f.replies['GET /api/v1/billing/claimmd/status']={connected:true};
 f.replies['GET /api/v1/billing/payers']={items:[{content:{active:true,name:'Synthetic Payer'}}]};
 f.replies['GET /api/v1/billing/payments/settings']={setting:{mode:'suncharts_connect',provider_account_id:'synthetic-account',details_submitted:true,charges_enabled:true,card_payments_active:true,payouts_enabled:true,requirements_currently_due:[],requirements_past_due:[]}};
 await f.run('showPracticeAdmin()');html=f.element('practice-admin-panel').innerHTML;
 assert.equal((html.match(/class="frame-admin-status">Done/g)||[]).length,7);
 assert.doesNotMatch(html,/Some setup details could not be checked/);
 // A provider NPI is the existing fallback when there is no group NPI.
 f.run("practiceAdminState.billingOrganizations.items[0].npi=''");
 assert.match(f.run('practiceBillingSetup(practiceAdminState)'),/Done<\/span><button type="button" data-billing-organizations>Billing NPI set/);
 f.run("practiceAdminState.providers.items[0].active=false;practiceAdminState.billingOrganizations.items[0].active=false;practiceAdminState.facilities.items[0].active=false;practiceAdminState.payers.items[0].content.active=false;practiceAdminState.clearinghouse.connected=false;practiceAdminState.payments.setting.requirements_currently_due=['synthetic_requirement']");
 html=f.run('practiceBillingSetup(practiceAdminState)');assert.equal((html.match(/>Not done<\/span>/g)||[]).length,7,'inactive records and incomplete payment setup do not count');
 for(const attr of ['data-billing-organizations','data-admin-tab="facilities"','data-go-nav="nav-edi"','data-admin-payers','data-admin-tab="providers"','data-payment-settings'])assert(html.includes(attr));
 console.log('PASS checklist complete, missing, unavailable and inactive states with fix destinations');
 // Framing completed screens moves the original live nodes and is idempotent.
 const form={value:'synthetic unsaved input'},status={id:'synthetic-status'},moved=[];
 let framed=false,markup='';const host={childNodes:[form,status],querySelector:selector=>selector==='.frame-admin'?(framed?{}:null):{append:(...nodes)=>moved.push(...nodes)},get innerHTML(){return markup;},set innerHTML(value){markup=value;framed=true;}};
 f.context.$=()=>host;f.run("practiceAdminFrame('fees');practiceAdminFrame('fees')");
 assert.deepEqual(moved,[form,status]);assert.equal(moved[0].value,'synthetic unsaved input');assert.match(markup,/Admin \/ Billing \/ Practice fees/);
 // Directory navigation from another screen must reload the directory, not a detached panel.
 f=fixture();await f.run("showPracticeAdmin('staff')");
 const tab={dataset:{adminTab:'providers'},hasAttribute:()=>false,closest:selector=>selector==='button'||selector==='.practice-admin-nav'?tab:null};
 for(const handler of f.handlers.click)handler({target:tab,preventDefault(){}});
 assert.equal(f.run('practiceAdminState.tab'),'providers');assert.match(f.element('practice-admin-panel').innerHTML,/Admin \/ People \/ Provider directory/);
 const opened=[];f.context.$=id=>id==='practice-admin-panel'?null:f.element(id);f.context.showPracticeAdmin=key=>opened.push(key);
 for(const handler of f.handlers.click)handler({target:tab,preventDefault(){}});
 assert.deepEqual(opened,['providers'],'directory navigation from an external screen opens the existing directory loader');
 console.log('PASS framing preserves live nodes and directory navigation updates or reopens the selected screen');
 const hooks={'practice-billing.js':'organizations','fees.js':'fees','data-import.js':'import','partners.js':'partners','integrations.js':'integrations','terminology.js':'codes','clearinghouse.js':'claims','card-readers.js':'readers','workflow-studio.js':'workflows'};
 for(const [file,key] of Object.entries(hooks))assert(fs.readFileSync('web/'+file,'utf8').includes(`practiceAdminFrame('${key}')`),file);
 assert.match(fs.readFileSync('web/scheduling.js','utf8'),/Admin \/ Practice \/ Calendar links/);
 for(const file of ['specialty-workspace.js','patient-payment-plans.js'])assert.doesNotMatch(fs.readFileSync('web/'+file,'utf8'),/Refresh directory|adminTabs\(/);
 const css=fs.readFileSync('web/frame.css','utf8');assert.match(css,/grid-template-columns:204px minmax\(0,1fr\)/);assert.match(css,/\.practice-admin-nav\{display:block/);assert.match(css,/\.frame-admin-group h3\{[^}]*text-transform:uppercase[^}]*color:var\(--muted\)/);assert.match(css,/@media\(max-width:600px\)\{\s*\.frame-admin\{grid-template-columns:minmax\(0,1fr\)/);
 console.log('PASS screen hooks, calendar sheet, responsive left panel and Stage 1 tokens');
})().catch(error=>{console.error(error);process.exitCode=1;});
