// The patient header stays compact while encounter progress lives on the Visit page.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const bannerSource=fs.readFileSync(path.join(__dirname,'../web/patient-banner.js'),'utf8');
const revenueSource=fs.readFileSync(path.join(__dirname,'../web/patient-revenue.js'),'utf8');
const modelStart=revenueSource.indexOf('const encounterStepChips=');
const modelEnd=revenueSource.indexOf('function encounterStepsSchedule(',modelStart);
assert.ok(modelStart>=0&&modelEnd>modelStart);
const bannerStart=bannerSource.indexOf('function patientBannerClaimMarkup(');
assert.ok(bannerStart>=0);
let row=null;
const banner={insertAdjacentHTML(_,html){row={html,remove(){row=null;},set outerHTML(value){row.html=value;}};}};
const visit={id:'v1',status:'signed',encounter_number:7,appointment_id:'a1'};
const box=vm.createContext({
 selected:'p1',activeVisit:null,workspace:{visits:[visit]},esc:String,
 encounterNumberText:v=>v?`ENC-${String(v.encounter_number).padStart(4,'0')}`:'',
 visitHandoffEvidence:s=>s.handoff,
 document:{getElementById:id=>id==='patient-banner-claim'?row:id==='patient-banner'?banner:null}
});
vm.runInContext(`let patientBannerClaim={patient:null,claim:null,bar:'',now:''};\n${bannerSource.slice(bannerStart)}`,box);
vm.runInContext(revenueSource.slice(modelStart,modelEnd),box);
const chips=vm.runInContext('JSON.stringify(encounterStepChips)',box);
assert.deepEqual(JSON.parse(chips),[['1','Visit'],['codes','Codes'],['claim','Claim'],['2','Payment']]);
const summary={state:'post_charges',insurance:{insured:false},charges_cents:28000,balance_cents:28000,account:{status:'draft'},patient:{owes_now_cents:0}};
function state(over={}){return JSON.parse(JSON.stringify(box.encounterStepsModel({...summary,...over},visit)));}
let model=state();
assert.equal(model.selfPay,true);assert.equal(model.current,1);assert.deepEqual(model.states,['current','todo']);
model=state({state:'self_pay_collect',account:{status:'posted'},patient:{owes_now_cents:28000}});
assert.equal(model.current,2);assert.deepEqual(model.states,['done','current']);
model=state({state:'paid_in_full',account:{status:'posted'},balance_cents:0});
assert.deepEqual(model.states,['done','done']);
// For insured work, signing and posting still leave the user on Visit while delivery is pending.
const insured={state:'send_claim',account:{status:'posted'},insurance:{insured:true,status:'not_sent'},claim:{id:'c1',status:'ready'},patient:{owes_now_cents:2500}};
model=state({...insured,handoff:{outcome:'queued'}});
assert.equal(model.selfPay,false);assert.equal(model.current,1);assert.equal(model.sent,false);
model=state({...insured,handoff:{outcome:'delivered'}});
assert.equal(model.current,2);assert.equal(model.sent,true);
// The stand-alone claim can show its strip. Opening a visit clears it and keeps claim details on Visit.
const claim={id:'c1',patient_id:'p1',snapshot:{account:{content:{visit_id:'v1'}}}};
box.patientBannerClaimSet(claim,'<ol></ol>','Soon');
assert.match(row.html,/data-claim-open="c1"/);assert.match(row.html,/ENC-0007/);
box.activeVisit=visit;
box.patientBannerEncounterSync(summary,visit);
assert.equal(row,null,'opening a visit removes the stale claim strip');
box.patientBannerClaimSet(claim,'<ol></ol>','Soon');
assert.equal(row,null,'an open visit keeps progress on its own page');
box.activeVisit=null;
box.patientBannerClaimSet({...claim,patient_id:'another-patient'},'<ol></ol>','Soon');
assert.equal(row,null,'a different patient never supplies the visible claim strip');
console.log('PASS encounter sections show correct self-pay and insured progress without duplicating claim status in the patient header');
