// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{JSDOM}=require('jsdom');
const base='/api/v1/labs/inbox',criticalPath=base+'?critical=true';
const row=(index,critical=false)=>({
 report_id:'report-'+index,order_id:'order-'+index,patient_id:'synthetic-patient',
 patient_name:'Synthetic patient',mrn:'SYN-1',status:'final',critical,
 title:critical?'Synthetic critical panel '+index:'Synthetic routine panel '+index
});

(async()=>{
 const dom=new JSDOM('<section id="tools"></section>',{runScripts:'outside-only'});
 const w=dom.window,paths=[];
 let pending;
 w.$=id=>w.document.getElementById(id);
 w.esc=value=>String(value??'');
 w.displayStatus=String;
 w.showTool=()=>{};
 w.run=fn=>{pending=fn();return pending;};
 const ordinary=Array.from({length:100},(_,i)=>row(i));
 const critical=[row(100,true),row(101,true),row(102,true)];
 w.api=async path=>{
  paths.push(path);
  return {items:path===criticalPath?critical:ordinary,limit:100,total:103,critical_count:3};
 };
 vm.runInContext(fs.readFileSync('web/labs.js','utf8'),dom.getInternalVMContext());

 await w.showLabInbox('critical');
 assert.deepEqual(paths,[criticalPath]);
 assert.equal(w.document.querySelectorAll('[data-open-lab-patient]').length,3);
 assert.match(w.$('tools').textContent,/Synthetic critical panel 102/);
 assert.doesNotMatch(w.$('tools').textContent,/Synthetic routine panel/);
 assert.equal(w.document.querySelector('[data-lab-filter="critical"]').getAttribute('aria-pressed'),'true');

 w.document.querySelector('[data-lab-filter="all"]').click();
 await pending;
 assert.deepEqual(paths,[criticalPath,base]);
 assert.match(w.$('tools').textContent,/Showing 100 of 103 results/);
 assert.equal(w.document.activeElement.dataset.labFilter,'all');
 w.document.querySelector('[data-lab-filter="critical"]').click();
 await pending;
 assert.deepEqual(paths,[criticalPath,base,criticalPath]);
 assert.match(w.$('tools').textContent,/Synthetic critical panel 100/);

 let releaseCritical;
 w.api=path=>path===criticalPath?new Promise(resolve=>{releaseCritical=resolve;}):Promise.resolve({items:ordinary,limit:100,total:103,critical_count:3});
 await w.showLabInbox();
 w.document.querySelector('[data-lab-filter="critical"]').click();
 const slowResponse=pending;
 w.document.querySelector('[data-lab-filter="all"]').click();
 releaseCritical({items:critical,limit:100,total:103,critical_count:3});
 await slowResponse;
 assert.equal(w.document.querySelector('[data-lab-filter="all"]').getAttribute('aria-pressed'),'true');
 assert.match(w.$('tools').textContent,/Synthetic routine panel 0/);

 // Older servers ignore the parameter and return the normal capped page.
 w.api=async()=>({items:ordinary,limit:100});
 await w.showLabInbox('critical');
 assert.match(w.$('tools').textContent,/Only the first 100 results were loaded/);
 assert.match(w.$('tools').textContent,/No critical results in the loaded page/);
 w.api=async()=>({items:[row(1),row(2,true)],limit:100});
 await w.showLabInbox('critical');
 assert.match(w.$('tools').textContent,/Synthetic critical panel 2/);
 assert.doesNotMatch(w.$('tools').textContent,/Synthetic routine panel/);

 dom.window.close();
 console.log('PASS lab inbox remote filter, exact result count and older-server fallback');
})().catch(error=>{console.error(error);process.exitCode=1;});
