// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A payment receipt reads like a visit receipt: diagnoses (ICD-10), then procedures with their
// charges, then insurance and how the patient paid. Receipts carry a number people can read out
// (ENC-0042-03), never an internal id.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const visit={id:'visit-1',appointment_id:'appt-1',encounter_number:42};
const account={id:'acct-1',status:'posted',coverage_id:'cov-1',content:{visit_id:'visit-1',service_date:'2026-11-18',claim_details:{rendering_provider_name:'Synthetic Park MD'},lines:[
 {code_system:'CPT',code:'64616',description:'Chemodenervation of neck muscles',modifiers:'LT',units:1,amount_cents:35000},
 {code_system:'HCPCS',code:'J0585',description:'OnabotulinumtoxinA 1 unit',modifiers:'JZ',units:200,amount_cents:90000,service_from:'2026-11-18',service_to:'2026-11-19'}]}};
const copays=[
 {id:'r-a',appointment_id:'appt-1',payment_group_id:null,created_at:'2026-11-18T10:00:00Z',voided:true,amount_cents:500},
 {id:'r-b1',appointment_id:'appt-1',payment_group_id:'g-1',created_at:'2026-11-18T11:00:00Z',amount_cents:6000,method:'external'},
 {id:'r-b2',appointment_id:'appt-1',payment_group_id:'g-1',created_at:'2026-11-18T11:00:01Z',amount_cents:4000,method:'cash'},
 {id:'r-c',appointment_id:'appt-1',payment_group_id:null,created_at:'2026-11-19T09:00:00Z',amount_cents:100,method:'cash'},
 {id:'r-other',appointment_id:'appt-2',payment_group_id:null,created_at:'2026-11-17T09:00:00Z',amount_cents:100,method:'cash'}];

function load(diagnoses){
 const ctx={console,Date,Intl,Math,Number,String,JSON,Array,Set,Map,URL,encodeURIComponent,Promise,esc,
  money:n=>'$'+(n/100).toFixed(2),date:String,human:String,crypto:{randomUUID:()=>'x'},
  document:{addEventListener(){},querySelector:()=>null},
  workspace:{visits:[visit],billing:{accounts:[account],coverages:[{id:'cov-1',content:{plan_name:'Synthetic primary plan'}}],copays}},
  encounterNumberForAppointment:id=>id==='appt-1'?'ENC-0042':'',
  patientPrintBranding:()=>({name:'Synthetic Practice'}),patientPrintHead:t=>`<html><head><title>${t}</title></head>`,patientPrintHeader:t=>`<h1>${t}</h1>`,patientPrintFooter:()=>'',
  invoicePaymentMethod:m=>m,testPaymentTag:()=>'',
  api:async url=>{if(diagnoses instanceof Error)throw diagnoses;assert.equal(url,'/api/v1/visits/visit-1/diagnoses');return {diagnoses};}};
 vm.createContext(ctx);
 const billing=fs.readFileSync('web/billing.js','utf8');
 vm.runInContext(billing.slice(billing.indexOf('function receiptNumberFor('),billing.indexOf('function billingEncounterReceiptRows(')),ctx);
 vm.runInContext(fs.readFileSync('web/patient-revenue.js','utf8'),ctx);
 return ctx;
}
const at=(html,text)=>{const i=html.indexOf(text);assert.ok(i>=0,'missing '+text);return i;};

(async()=>{
 // Receipt numbers: oldest first per encounter, voided payments keep their place, one number per payment group.
 {
  const c=load([]);
  assert.equal(c.receiptNumberFor('appt-1','r-a'),'ENC-0042-01');
  assert.equal(c.receiptNumberFor('appt-1','g-1'),'ENC-0042-02');
  assert.equal(c.receiptNumberFor('appt-1','r-c'),'ENC-0042-03');
  assert.equal(c.receiptNumberFor('appt-2','r-other'),'Payment 1 on this visit','no encounter number: a plain fallback, never an id');
  assert.equal(c.receiptNumberFor('appt-1','missing'),'');
 }
 // Grouped receipt: diagnoses, then procedures, then insurance, then how it was paid; no internal ids.
 {
  const c=load([{code:'G24.01',display:'Drug induced subacute dyskinesia',rank:2},{code:'G24.3',display:'Spasmodic torticollis',rank:1}]);
  const evidence=await c.visitReceiptEvidence('appt-1');
  const receipts=copays.filter(r=>r.payment_group_id==='g-1');
  const doc=c.paymentGroupReceiptDocument(receipts,{patient:{given_name:'Avery',family_name:'Synthetic',mrn:'MRN1'},practiceName:'Synthetic Practice',visitEvidence:evidence,printedAt:'2026-11-20'});
  const order=[at(doc,'Receipt ENC-0042-02'),at(doc,'<h2>Diagnoses</h2>'),at(doc,'G24.3'),at(doc,'G24.01'),at(doc,'<h2>Procedures</h2>'),at(doc,'64616'),at(doc,'J0585'),at(doc,'Total charges'),at(doc,'<h2>Insurance</h2>'),at(doc,'How it was paid')];
  assert.deepEqual([...order].sort((a,b)=>a-b),order,'header, diagnoses (primary first), procedures, insurance, then payment');
  for(const text of ['Encounter ENC-0042','Date of service 2026-11-18','Provider Synthetic Park MD','LT','JZ','200','$350.00','$900.00','$1250.00','2026-11-18 – 2026-11-19','Synthetic primary plan','$100.00'])
   assert.ok(doc.includes(text),text);
  for(const id of ['r-b1','r-b2','g-1'])assert.ok(!doc.includes(id),'no internal id '+id);
 }
 // Single receipt: same visit sections; its number, not its id.
 {
  const c=load([{code:'G24.3',display:'Spasmodic torticollis',rank:1}]);
  const evidence=await c.visitReceiptEvidence('appt-1');
  const doc=c.copayReceiptDocument({...copays[3],allocated_cents:0,reversed_cents:0},{patient:{given_name:'Avery',family_name:'Synthetic'},appointment:null,practiceName:'Synthetic Practice',visitEvidence:evidence,printedAt:'2026-11-20'});
  assert.ok(doc.includes('Receipt ENC-0042-03'));assert.ok(!doc.includes('Receipt r-c'));
  assert.ok(doc.includes('<title>Payment receipt'),'a cash payment is a payment receipt, not a copay receipt');
  assert.ok(at(doc,'<h2>Diagnoses</h2>')<at(doc,'<h2>Procedures</h2>'));
 }
 // No charges yet, and diagnoses that could not be loaded, read plainly instead of as empty tables.
 {
  const c=load(new Error('offline'));
  const bare={...account,content:{...account.content,lines:[]}};c.workspace.billing.accounts=[bare];
  const evidence=await c.visitReceiptEvidence('appt-1');
  const html=c.visitReceiptSections(evidence);
  assert.match(html,/No charges posted yet\./);assert.match(html,/Diagnoses could not be loaded/);assert.ok(!html.includes('<table>'));
  assert.equal(c.visitReceiptSections(null),'','no encounter: no visit sections');
 }
 console.log('PASS receipts: readable ENC receipt numbers, diagnoses then procedures then payment, plain empty and failed states');
})().catch(e=>{console.error(e);process.exitCode=1;});
