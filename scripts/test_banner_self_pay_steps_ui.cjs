// The progress line under the patient banner follows the open encounter: a self-pay encounter
// shows three steps and no insurance step; a claim line from another encounter is taken down.
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../web/patient-banner.js'),'utf8');
const pick=name=>{const at=source.indexOf(`function ${name}(`);assert(at>=0,name);let depth=0,i=source.indexOf('{',at);for(;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)break;}return source.slice(at,i+1);};
let row=null;const banner={insertAdjacentHTML:(_,html)=>{row={html,remove(){row=null;},set outerHTML(v){row.html=v;}};}};
const box={selected:'p1',workspace:{visits:[]},esc:v=>String(v),money:c=>'$'+(c/100).toFixed(2),encounterNumberText:v=>!v?"":`ENC-${String(v.encounter_number).padStart(4,'0')}`,
 document:{getElementById:id=>id==='patient-banner-claim'?row:id==='patient-banner'?banner:null}};
vm.createContext(box);
vm.runInContext(`let patientBannerClaim={patient:null,claim:null,bar:'',now:''};\n${['patientBannerClaimMarkup','patientBannerSelfPaySteps','patientBannerEncounterSync','patientBannerClaimSet'].map(pick).join('\n')}\nthis.shown=()=>patientBannerClaim;`,box);
const visit={id:'v1',encounter_number:7},selfPay=(over={})=>({insurance:{insured:false},charges_cents:28000,balance_cents:28000,account:{status:'draft'},patient:{owes_now_cents:0},...over});
// Draft self-pay: charges are in, posting is next; no insurance, eligibility or clearinghouse step.
box.patientBannerEncounterSync(selfPay(),visit);
assert.match(row.html,/Self-pay · ENC-0007/);assert.match(row.html,/1 of 3 done · Now: Post charges/);
assert.equal((row.html.match(/<li /g)||[]).length,3);assert.doesNotMatch(row.html,/Insurance|Eligibility|clearinghouse|payer/i);
// Posted and owing: collecting is next.
box.patientBannerEncounterSync(selfPay({account:{status:'posted'},patient:{owes_now_cents:28000}}),visit);
assert.match(row.html,/2 of 3 done · Now: Collect payment/);assert.match(row.html,/The patient owes \$280\.00\./);
// Paid.
box.patientBannerEncounterSync(selfPay({account:{status:'posted'},balance_cents:0,patient:{owes_now_cents:0}}),visit);
assert.match(row.html,/All done · Paid in full/);assert.equal((row.html.match(/is-complete/g)||[]).length,3);
// Moving to an insured encounter takes the self-pay line down; its claim line is drawn by the claim itself.
box.patientBannerEncounterSync({insurance:{insured:true},charges_cents:100,claim:{id:'c2'}},{id:'v2',encounter_number:8});
assert.equal(row,null);
// A claim line left from another encounter is removed; the open encounter's own claim line stays.
box.patientBannerClaimSet({id:'c1',patient_id:'p1',snapshot:{account:{content:{visit_id:'v1'}}}},'<ol></ol>','now');assert.ok(row);
box.patientBannerEncounterSync({insurance:{insured:true},charges_cents:100,claim:{id:'c1'}},visit);assert.ok(row,'the open encounter keeps its claim line');
box.patientBannerEncounterSync({insurance:{insured:true},charges_cents:100,claim:null},{id:'v3',encounter_number:9});assert.equal(row,null);
console.log('ok banner self-pay steps');
