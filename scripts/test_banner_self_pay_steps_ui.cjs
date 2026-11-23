// The line under the patient banner follows the open encounter: it is that encounter's one timeline
// (a self-pay encounter has no claim or insurer step); a claim strip left over from another encounter
// is taken down; with an encounter open the claim's own strip is not drawn in the header.
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../web/patient-banner.js'),'utf8');
const pick=name=>{const at=source.indexOf(`function ${name}(`);assert(at>=0,name);let depth=0,i=source.indexOf('{',at);for(;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)break;}return source.slice(at,i+1);};
let row=null;const banner={insertAdjacentHTML:(_,html)=>{row={html,remove(){row=null;},set outerHTML(v){row.html=v;}};}};
const box={selected:'p1',workspace:{visits:[],appointments:[{id:'a1',status:'in_progress',title:'Visit',starts_at:'2030-01-02T09:00:00Z'}]},esc:v=>String(v),money:c=>'$'+(c/100).toFixed(2),encounterNumberText:v=>!v?"":`ENC-${String(v.encounter_number).padStart(4,'0')}`,
 displayDate:v=>String(v).slice(0,10),displayTime:v=>String(v),visitBillingDate:v=>String(v),
 document:{getElementById:id=>id==='patient-banner-claim'?row:id==='patient-banner'?banner:null}};
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/encounter-timeline.js'),'utf8'),box);
vm.runInContext(`let patientBannerClaim={patient:null,claim:null,bar:'',now:''};\n${['patientBannerClaimMarkup','patientBannerEncounterOpen','patientBannerEncounterSync','patientBannerClaimSet'].map(pick).join('\n')}\nthis.shown=()=>patientBannerClaim;`,box);
const visit={id:'v1',status:'signed',encounter_number:7,appointment_id:'a1'},selfPay=(over={})=>({state:'post_charges',insurance:{insured:false},charges_cents:28000,balance_cents:28000,account:{status:'draft'},patient:{owes_now_cents:0},...over});
// Draft self-pay: posting is next; no claim, insurer, eligibility or clearinghouse step.
box.patientBannerEncounterSync(selfPay(),visit);
assert.match(row.html,/class="patient-banner-row patient-banner-timeline" id="patient-banner-claim"/);assert.match(row.html,/ENC-0007/);assert.match(row.html,/Now: Charges posted/);
assert.equal((row.html.match(/<li /g)||[]).length,4);assert.doesNotMatch(row.html,/Claim sent|Insurer|Eligibility|clearinghouse|payer/i);
// Posted and owing: collecting is next.
box.patientBannerEncounterSync(selfPay({state:'self_pay_collect',account:{status:'posted'},patient:{owes_now_cents:28000}}),visit);
assert.match(row.html,/Now: Closed\. Patient owes \$280\.00/);
// Paid.
box.patientBannerEncounterSync(selfPay({state:'paid_in_full',account:{status:'posted'},balance_cents:0,patient:{owes_now_cents:0}}),visit);
assert.equal((row.html.match(/is-done/g)||[]).length,4);assert.match(row.html,/4 of 4 done/);
// The same strip is drawn for an insured encounter, with its claim and insurer steps.
box.patientBannerEncounterSync({state:'send_claim',insurance:{insured:true,status:'not_sent'},charges_cents:100,account:{status:'posted'},claim:{id:'c2'},patient:{}},{id:'v2',status:'signed',encounter_number:8});
assert.match(row.html,/Claim sent/);assert.match(row.html,/Insurer paid/);
// With an encounter open, the claim's own strip is not drawn in the header.
box.activeVisit=visit;row.html='TIMELINE';
box.patientBannerClaimSet({id:'c1',patient_id:'p1',snapshot:{account:{content:{visit_id:'v1'}}}},'<ol></ol>','now');assert.equal(row.html,'TIMELINE');
// With no encounter open, the claim strip is drawn as before.
box.activeVisit=undefined;box.patientBannerClaimSet({id:'c1',patient_id:'p1',snapshot:{account:{content:{visit_id:'v1'}}}},'<ol></ol>','now');assert.match(row.html,/patient-banner-claim-name/);assert.match(row.html,/data-claim-open="c1"/);
console.log('ok banner follows the open encounter timeline');
