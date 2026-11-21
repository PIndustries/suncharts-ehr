// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Claim details read first: only fields that hold a value are listed, under the words on their
// label; a ticked box reads Yes, a select reads its chosen option, the fields behind Change and the
// fee place are left to the provider summary. The encounter bar copies the card's next step and
// totals, adds Money details, and is not shown while there are no charges.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('web/patient-revenue.js','utf8');
const rowsSrc=src.slice(src.indexOf('function encounterDetailsSummaryRows('),src.indexOf('function encounterDetailsSummaryRender('));
const barSrc=src.slice(src.indexOf('let encounterBarTimer=null;'),src.indexOf('function encounterBarWatch('));
const field=(name,label,extra={})=>({name,type:'text',tagName:'INPUT',value:'',checked:false,...extra,closest:sel=>sel==='label'?{childNodes:[{nodeType:3,textContent:` ${label} `},{nodeType:1,textContent:'ignored'}]}:sel==='[data-encounter-provider-fields]'?(extra.behindChange?{}:null):null});
const fields=[field('service_date','Service date',{type:'date',value:'2030-01-02'}),field('prior_authorization_number','Prior authorization number (box 23)',{value:' SYN-AUTH-1 '}),field('illness_date','Date the illness began',{type:'date'}),
 field('paper_only','Do not send this claim electronically',{type:'checkbox',checked:true}),field('hold','Hold for review',{type:'checkbox'}),
 field('secondary','Secondary insurance',{tagName:'SELECT',value:'primary_only',selectedOptions:[{textContent:' Bill the primary only '}]}),field('batch','Batch number',{tagName:'SELECT',value:'',selectedOptions:[{textContent:'Choose'}]}),
 field('rendering_npi','Rendering provider',{value:'1234567893',behindChange:true}),field('fee_facility','Service facility',{value:'x'}),field('coverage_id','Billing coverage',{value:'c'}),field('service_date','Service date again',{value:'dup'})];
const form={querySelectorAll:sel=>sel.startsWith('[data-visit-charge-options]')?[{querySelectorAll:()=>fields}]:[]};
const ctx={Set,String,visitBillingDate:v=>`date(${v})`};vm.createContext(ctx);vm.runInContext(rowsSrc,ctx);
assert.deepEqual(JSON.parse(JSON.stringify(ctx.encounterDetailsSummaryRows(form))),[['Service date','date(2030-01-02)'],['Prior authorization number (box 23)','SYN-AUTH-1'],['Do not send this claim electronically','Yes'],['Secondary insurance','Bill the primary only']]);
// The bar.
function page(state,withTable=true){
 const nodes={};
 const card={getAttribute:()=>state,querySelector:sel=>sel==='.visit-billing-status'?{outerHTML:'<div class="visit-billing-status">STEP</div>'}:sel==='.visit-billing-totals'?{outerHTML:'<p class="visit-billing-totals">TOTALS</p>'}:sel==='.visit-billing-breakdown'?(withTable?{}:null):null};
 nodes['encounter-revenue-status']={querySelector:sel=>sel==='.visit-billing-card'?card:null};
 const host={style:{setProperty(){}},querySelector(){return null;},children:[],insertBefore(node){nodes['encounter-bar']=node;node.remove=()=>{delete nodes['encounter-bar'];};this.children.push(node);}};
 nodes['visit-page-host']=host;
 const c={$:id=>nodes[id]||null,document:{createElement:()=>({dataset:{},setAttribute(){},set innerHTML(v){this.html=v;},get innerHTML(){return this.html;}}),querySelector:()=>null},getComputedStyle:()=>({top:'0px'}),parseFloat,Math,clearTimeout,setTimeout};
 vm.createContext(c);vm.runInContext(barSrc,c);return {c,nodes};
}
{const {c,nodes}=page('post_charges');c.encounterBarSync();const bar=nodes['encounter-bar'];
 assert.equal(bar.html,'<div class="visit-billing-status">STEP</div><p class="visit-billing-totals">TOTALS<button type="button" class="text-button" data-money-details>Money details</button></p>');
 assert.equal(bar.dataset.visitBillingState,'post_charges');}
{const {c,nodes}=page('post_charges',false);c.encounterBarSync();assert.doesNotMatch(nodes['encounter-bar'].html,/Money details/,'no table, no button for it');}
{const {c,nodes}=page('add_charges');c.encounterBarSync();assert.equal(nodes['encounter-bar'],undefined,'no charges yet: no bar');}
assert.match(src,/data-details-edit>Edit claim details</);
console.log('PASS claim details read first and the encounter bar: listed values, skipped fields, copied next step with Money details, no bar without charges');
