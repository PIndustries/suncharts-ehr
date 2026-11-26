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
// The old bar is retired; its existing refresh entry point reconciles the five steps.
let removed=0,scheduled=0;
vm.runInNewContext(barSrc,{$:()=>({remove:()=>removed++}),encounterStepsSchedule:()=>scheduled++});
const refresh={ $:()=>({remove:()=>removed++}),encounterStepsSchedule:()=>scheduled++};
vm.createContext(refresh);vm.runInContext(barSrc,refresh);refresh.encounterBarSync();
assert.equal(removed,1);assert.equal(scheduled,1);
assert.match(src,/data-details-edit>Edit claim details</);
console.log('PASS claim details keep listed values and the old next-step bar refreshes the stepper');

// The Summary note action focuses the encounter. Finish invokes encounter completion.
{const start=src.indexOf('// The bar\'s note-side steps:'),end=src.indexOf('\n});',start)+4,events=[],calls=[];
 const c={document:{addEventListener:(kind,fn)=>events.push(fn),querySelector:()=>null},chartSection:'overview',showChartSection:key=>calls.push(['section',key]),invoiceTabSet:key=>calls.push(['tab',key]),run:fn=>fn(),finishVisitEncounter:()=>calls.push(['finish']),$:()=>null};
 vm.runInNewContext(src.slice(start,end),c);
 events[0]({target:{closest:()=>({dataset:{encounterNext:'note'}})},preventDefault(){}});
 assert.deepEqual(calls,[['section','visits'],['tab','note']]);
 calls.length=0;events[0]({target:{closest:()=>({dataset:{encounterNext:'finish'}})},preventDefault(){}});
 assert.deepEqual(calls,[['section','visits'],['finish']]);
 console.log('PASS Summary next-step opens the encounter before note / finish navigation');
}
