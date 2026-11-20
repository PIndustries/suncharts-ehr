// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// 'Print receipt' on the Collect payment success panel opens that payment's one grouped receipt in a
// preview window (Print and Close): the payment window stays open under it, the page does not move
// and no receipt card is dropped into the encounter. The test drives the real click handler and the real
// grouped receipt document in web/patient-revenue.js against vm stubs.
const RECEIPT_URL=id=>`/api/v1/billing/copay-receipts/${id}`;
const groupUrl=g=>`/api/v1/patients/patient/billing/payment-groups/${g}`;
const FAIL_TEXT='The receipt could not be loaded. Try again.';

function harness(opts){
  const failGroup=!!(opts&&opts.failGroup),emptyGroup=!!(opts&&opts.emptyGroup);
  const identity={role:'owner'};
  const calls={api:[],sections:[],selected:[],previews:[],close:0,scroll:0,print:0,focus:0,errors:[]};
  const receiptHost={id:'encounter-copay-receipt',hidden:true,innerHTML:'',scrollIntoView(){calls.scroll++;}};
  const mounts=[];
  const mounted=(parent,child)=>{mounts.push({parent,child});child.parentNode=parent;};
  const ancestors=child=>{const out=[];for(let n=child&&child.parentNode;n;n=n.parentNode)out.push(n);return out;};
  const panel={isConnected:true,tagName:'SECTION',className:'collect-done',attrs:{},
    setAttribute(k,v){panel.attrs[k]=v;},getAttribute(k){return panel.attrs[k];},
    querySelector(){return null;},querySelectorAll(){return [];},
    closest(sel){return sel==='.collect-done'?panel:null;},
    contains(child){return ancestorsOf(child).includes(panel);},
    append(child){mounted(panel,child);if(child===frame)frame.reload();},
    remove(){}};
  const button={isConnected:true,disabled:false,attrs:{},
    dataset:{collectReceipt:'group-1',appointment:'appointment'},
    setAttribute(k,v){button.attrs[k]=v;},getAttribute(k){return button.attrs[k];},
    closest(sel){return sel==='.collect-done'?panel:null;}};
  // The print frame, stubbed as a browser behaves: it fires load when it is in the document with a
  // document to show, whichever of the two arrives second. A detached frame never prints.
  const frame={isConnected:true,tagName:'IFRAME',className:'',title:'',attrs:{},_load:null,_doc:null,
    setAttribute(k,v){frame.attrs[k]=v;},getAttribute(k){return frame.attrs[k];},
    addEventListener(type,fn){if(type==='load')frame._load=fn;},
    closest(sel){return sel==='.collect-done'?panel:null;},
    remove(){const i=mounts.findIndex(m=>m.child===frame);if(i>=0)mounts.splice(i,1);frame.parentNode=null;},
    reload(){if(frame.parentNode&&frame._doc!==null&&frame._load)frame._load();},
    contentWindow:{focus(){calls.focus++;},print(){calls.print++;}}};
  Object.defineProperty(frame,'srcdoc',{get(){return frame._doc;},set(v){frame._doc=v;frame.reload();}});
  const messageNode=()=>{const node={isConnected:true,tagName:'P',className:'',attrs:{},_text:'',
    setAttribute(k,v){node.attrs[k]=v;},getAttribute(k){return node.attrs[k];},
    closest(sel){return sel==='.collect-done'?panel:null;}};
    Object.defineProperty(node,'textContent',{get(){return node._text;},set(v){node._text=v;}});
    return node;};
  const doc={_l:{},
    addEventListener(type,fn){(doc._l[type]=doc._l[type]||[]).push(fn);},
    querySelector(){return null;},querySelectorAll(){return [];},
    documentElement:{classList:{add(){},remove(){}}},
    createElement:tag=>tag==='iframe'?frame:messageNode()};
  const ctx={console,Date,Intl,Math,Number,String,JSON,Array,Set,Map,URL,encodeURIComponent,Boolean,Promise,setTimeout,
    window:{SunChartsDialog:null},
    esc,money:n=>'$'+(n/100).toFixed(2),cents:Number,date:v=>String(v),
    crypto:{randomUUID:()=>'group-1'},
    document:doc,
    $:id=>id==='notice'||id==='shell-loading'?{hidden:true}:id==='encounter-copay-receipt'?receiptHost:null,
    me:identity,selected:'patient',chartSection:'charges',activeVisit:{id:'visit',appointment_id:'appointment'},
    encounterSection:'charges',workspace:{patient:'patient',appointments:[{id:'appointment'}],visits:[],billing:{accounts:[]},copays:[]},
    revenueAppointment:()=>({id:'appointment'}),
    billingEditorHost:()=>null,
    // The print document's own helpers, stubbed only as far as the wording they contribute.
    patientPrintBranding:()=>({name:'Synthetic Practice'}),
    patientPrintHead:title=>`<html><head><title>${title}</title></head>`,
    patientPrintHeader:title=>`<h1>${title}</h1><p class="practice">Synthetic Practice</p>`,
    patientPrintFooter:()=>'<p>Footer</p>',
    encounterNumberForAppointment:()=>'ENC-0007',
    invoicePaymentMethod:m=>m==='cash'?'Cash':m==='check'?'Check':'Card',
    testPaymentTag:()=>'',
    setEncounterSection:s=>calls.sections.push(s),
    selectPatient(...a){calls.selected.push(a);return Promise.resolve();},
    sheetClose(){calls.close++;},
    notice(e){calls.errors.push(e&&e.message);},
    // Like the real run(): the pressed button is disabled while the action runs, and a throw becomes
    // a notice. The action must still run with its button already disabled.
    run:action=>{button.disabled=true;return new Promise(r=>r(action())).catch(e=>{calls.errors.push(e&&e.message);}).finally(()=>{button.disabled=false;});},
    // api() is a round trip, so nothing is known until its awaits settle.
    api:async url=>{
      calls.api.push(url);
      await new Promise(r=>setTimeout(r,0));
      if(url===groupUrl('group-1')){
        if(failGroup)throw new Error('network down');
        if(emptyGroup)return {receipts:[]};
        return {receipts:[
          {id:'r1',payment_group_id:'group-1',appointment_id:'appointment',amount_cents:6000,method:'external',occurred_on:'2026-11-12',reference:''},
          {id:'r2',payment_group_id:'group-1',appointment_id:'appointment',amount_cents:4000,method:'cash',occurred_on:'2026-11-12',reference:''},
          {id:'r3',payment_group_id:'group-2',appointment_id:'appointment',amount_cents:1,method:'cash',occurred_on:'2026-11-12',reference:''}]};
      }
      if(url===RECEIPT_URL('r1'))return {receipt:{id:'r1'},context:{practiceName:'Synthetic Practice',patient:{given_name:'Avery',family_name:'Synthetic',mrn:'MRN1'}}};
      throw new Error('unexpected api call '+url);
    }};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
  ctx.openReceiptPreview=(doc,title)=>{calls.previews.push(doc);};
  // The window is open with its success panel showing, as collectPartTaken leaves it. Both
  // encounterRevenueState and collectDialog are module-level lets, so they are set inside the module.
  ctx.panelRef=panel;
  vm.runInContext(`encounterRevenueState={patient:'patient',identity:me,visit:'visit',data:{summary:{patient:{owes_now_cents:1400}}}};collectDialog={dataset:{},isConnected:true,contains(child){for(let n=child&&child.parentNode;n;n=n.parentNode)if(n===panelRef)return true;return false;},querySelector:()=>null};collectSession={target:10000,owedAtOpen:10000,taken:[{amount:10000,label:'cash'}],group:'group-1'};`,ctx);
  const click=()=>{for(const fn of doc._l.click||[])fn({preventDefault(){},target:{closest:sel=>sel==='[data-collect-receipt]'?button:null}});};
  // Two round trips (the group, then its first receipt), so settle long past both.
  const flush=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setTimeout(r,0));};
  return {calls,button,panel,frame,receiptHost,mounts,click,flush};
}

(async()=>{
  // Happy path: the grouped receipt prints in place, the window stays open and the page does not move.
  {
    const h=harness();
    h.click();
    assert.equal(h.button.disabled,true,'the button is disabled as soon as it is pressed');
    assert.equal(h.calls.api.length,1,'the group load starts right away');
    assert.equal(h.calls.print,0,'nothing is printed before the receipt is even loaded');
    await h.flush();
    assert.deepEqual(h.calls.errors,[],'nothing threw');
    assert.deepEqual(h.calls.api,[groupUrl('group-1'),RECEIPT_URL('r1')],'the payment group is loaded, then the first receipt for its context');
    assert.equal(h.calls.previews.length,1,'one preview window opens');
    const doc=h.calls.previews[0];
    assert.ok(doc&&doc.startsWith('<html>'),'the preview shows the whole print document');
    for(const text of ['Synthetic Practice','Avery Synthetic','MRN1','ENC-0007','Cash','$40.00','Total paid','$100.00','Patient balance after this payment','$14.00'])
      assert.ok(doc.includes(text),'the receipt carries '+text);
    assert.ok(!doc.includes('r3')&&!doc.includes('$1.00'),'only the receipts of this payment group are shown');
    assert.equal(h.calls.print,0,'printing waits for the Print button in the preview');
    assert.equal(h.button.disabled,false,'the button is usable again afterwards');
    assert.equal(h.calls.sections.length,0,'the encounter section is never switched');
    assert.equal(h.calls.selected.length,0,'no patient or visit is re-selected');
    assert.equal(h.calls.scroll,0,'the page does not scroll');
    assert.equal(h.calls.close,0,'the window is still open afterwards');
    assert.equal(h.receiptHost.innerHTML,'','no receipt card is dropped into the encounter');
  }
  // Loading fails: a plain message in the panel, the button usable again, nothing printed.
  {
    const h=harness({failGroup:true});
    h.click();
    await h.flush();
    const message=h.mounts.find(m=>m.child.textContent===FAIL_TEXT);
    assert.ok(message,'the failure message is shown');
    assert.equal(message.parent,h.panel,'the failure message is shown in the success panel');
    assert.equal(message.child.attrs.role,'status','the failure message is announced');
    assert.equal(h.button.disabled,false,'the button is re-enabled so staff can try again');
    assert.equal(h.calls.previews.length,0,'no preview opens');
    assert.equal(h.calls.close,0,'the window stays open');
    assert.equal(h.calls.sections.length,0,'the page still does not move');
  }
  // A group that comes back with no receipts of its own is a failure, not a blank print.
  {
    const h=harness({emptyGroup:true});
    h.click();
    await h.flush();
    assert.ok(h.mounts.some(m=>m.child.textContent===FAIL_TEXT),'an empty group reads as a failed load');
    assert.equal(h.calls.previews.length,0,'no preview for an empty group');
    assert.equal(h.button.disabled,false,'the button is re-enabled');
  }
  console.log('PASS collect Print receipt opens the grouped receipt in a preview even with its button disabled by run(): the window stays open, the page does not move, failures retry');
})();
