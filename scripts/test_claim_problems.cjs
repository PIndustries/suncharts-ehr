// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A claim that came back has to tell a front-desk person, in plain words, what the insurer or
// clearinghouse said and what to do about it — and the corrected claim has to go back out with the
// right claim frequency code. The words live in web/claim-problems.js, a pure module with no DOM.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

const source=fs.readFileSync('web/claim-problems.js','utf8');
// Loaded with only the globals a browser script gets — no module system, so nothing may reach for
// require, and no DOM beyond the `esc` helper app.js already provides to every screen.
const context=vm.createContext({esc:value=>String(value??''),Object,Array,JSON,String,Number,Boolean,RegExp,Math,Intl,TypeError,Set});
vm.runInContext(source,context);
const {claimProblemReport,claimResendPlan,claimFixPlan,claimProblemBoxMarkup}=context;

const account=memberId=>({id:'account',patient_id:'patient',version:4,status:'posted',total_cents:12500,
 content:{service_date:'2026-11-02',lines:[{code:'99213',units:1,amount_cents:12500}]},
 coverage_snapshot:{coverage:{content:{relationship:'self',member_id:memberId,group_number:'SYN-GROUP'}},payer:{content:{name:'Synthetic Payer',payer_code:'SYN-PAYER'}}}});
const content={billing_provider_name:'Synthetic Clinic',billing_npi:'1234567893',rendering_npi:'1234567893',tax_id:'123456789',billing_address:'1 Synthetic Way',patient_address:'1 Synthetic Way',subscriber_address:'1 Synthetic Way',subscriber_birth_date:'1990-01-01',place_of_service:'11',diagnosis_codes:['Z00.00'],line_diagnosis_pointers:[[1]],external_control_number:'',notes:''};
// A rejected claim, optionally with the payer's own claim number and a clearinghouse/payer message.
function cameBack({memberId='SYN-MEMBER-1',status='rejected',payerControlNumber='',message='',reason='',recorded='',feed=''}={}){
 return{claim:{id:'claim',patient_id:'patient',account_id:'account',payer_id:'payer',version:3,status,frequency:'original',payer_control_number:payerControlNumber,control_number:'SYNCLAIM000000001',content:{...content},
  snapshot:{patient:{given_name:'Avery',family_name:'Synthetic',birth_date:'1990-01-01',mrn:'SYN-MRN'},account:account(memberId)}},
  detail:{history:{items:reason?[{reason,evidence:{}}]:[]},
   tracking:{reports:message?[{received_at:'2026-11-08',evidence:{senderid:'SYN-PAYER',sender_name:'Synthetic Payer',status:'R',message:{status:'R',message}}}]:[]},
   // The answers on file travel with the claim detail: what staff recorded by hand, and what the
   // clearinghouse feed said. Kept apart so the box can be tested reading one, the other, or both.
   responses:{revisions:recorded?[{version:3,action:'record_rejection',reason:recorded}]:[],feed:feed?[{status:'R',sender:'SYN-CLEARINGHOUSE',message:feed,received_at:'2026-11-08'}]:[]}}};
}
const report=(options)=>{const {claim,detail}=cameBack(options);return claimProblemReport(claim,detail);};

// Not a claim that came back: nothing is shown at all.
for(const status of ['draft','ready','submitted','accepted','adjudicated','void']){
 assert.equal(claimProblemReport({...cameBack().claim,status},{}),null,`${status} is not a claim that came back`);
}
assert.equal(claimProblemReport(null,{}),null);

// Every answer the brief names is recognised, and the wording tells staff what to do.
const expected=[
 ['member ID — not recognised',()=>report({message:'2377 Invalid Subscriber ID'}),problem=>/member ID/i.test(problem)&&/card/i.test(problem),'member_id'],
 ['member ID — blank',()=>report({memberId:''}),problem=>/no member ID/i.test(problem)&&/Insurance/i.test(problem),'member_id'],
 ['subscriber mismatch',()=>report({message:'P159 Subscriber does not match the insured'}),problem=>/policy holder/i.test(problem),'subscriber'],
 ['diagnosis pointer',()=>report({message:'N205 Missing/Invalid Diagnosis Pointer'}),problem=>/charge line/i.test(problem)&&/diagnosis/i.test(problem),'diagnosis_pointer'],
 ['missing or wrong NPI',()=>report({message:'677 Missing Rendering Provider NPI'}),problem=>/10-digit NPI/i.test(problem),'billing_npi'],
 ['tax ID',()=>report({message:'66 Tax Identification Number Missing/Invalid'}),problem=>/tax ID/i.test(problem)&&/nine digits/.test(problem),'tax_id'],
 ['duplicate claim',()=>report({message:'17 Duplicate claim/service billed and paid'}),problem=>/already has a claim/i.test(problem)&&/duplicate/i.test(problem),''],
 ['timely filing',()=>report({message:'29 Timely filing time limit expired'}),problem=>/deadline/i.test(problem)&&/appeal/i.test(problem),''],
 ['no authorization',()=>report({message:'197 Prior authorization not obtained'}),problem=>/authorization/i.test(problem),'prior_authorization'],
 ['patient not eligible',()=>report({message:'26 The patient is not eligible for coverage for the date of service'}),problem=>/not covered on the date of service/i.test(problem),'member_id']
];
for(const [label,run,check,field] of expected){
 const result=run();
 assert.ok(result,`${label}: a rejected claim always gets a box`);
 assert.equal(result.problems.length,1,`${label}: ${JSON.stringify(result.problems)}`);
 assert.ok(check(result.problems[0]),`${label}: wording was ${result.problems[0]}`);
 assert.equal(result.field,field,`${label}: focus field for “${result.problems[0]}”`);
 assert.doesNotMatch(result.words,/[{}<>]|\bnull\b|undefined/,`${label}: no developer terms in ${result.words}`);
 assert.doesNotMatch(result.words,/\b[A-Z]{3,}_\w+\b/,`${label}: no code names in ${result.words}`);
}

// The answers travelling with the claim detail are read without the history endpoint being fetched
// again, and a denial phrased as a coverage problem is understood from the words staff typed.
const fromDetail=cameBack().claim;
const denialWords='Payer denied it: coverage not in effect on the date of service';
const detailAnswers=claimProblemReport(fromDetail,{responses:{revisions:[{version:4,action:'record_rejection',reason:denialWords}],feed:[]}});
assert.ok(detailAnswers, 'recorded answers alone are enough for the box');
assert.ok(detailAnswers.problems.some(words=>/not covered on the date of service/i.test(words)),
  `the recorded denial wording is read: ${JSON.stringify(detailAnswers.problems)}`);
// The clearinghouse row travelling alongside it is not dropped, so both answers get said.
const both=cameBack({recorded:denialWords,feed:'2377 Invalid Subscriber ID'});
const bothReport=claimProblemReport(both.claim,both.detail);
assert.ok(bothReport.problems.some(words=>/member ID/i.test(words)),
  `the clearinghouse row in the response feed is read: ${JSON.stringify(bothReport.problems)}`);
const feedOnlyRow=cameBack({feed:'2377 Invalid Subscriber ID'});
assert.ok(claimProblemReport(feedOnlyRow.claim,feedOnlyRow.detail).problems.some(words=>/member ID/i.test(words)),
  'the feed alone is enough, with nothing recorded by hand');
const feedOnly=claimProblemReport(fromDetail,{responses:{revisions:[{version:2,action:'record_rejection',message:'197 Prior authorization not obtained'}],feed:[]}});
assert.ok(feedOnly.problems.some(words=>/approval/i.test(words)),
  `a payer message recorded with the rejection is read: ${JSON.stringify(feedOnly.problems)}`);
assert.equal(claimProblemReport({...fromDetail,status:'rejected'},{responses:{revisions:[],feed:[]}}).problems[0].match(/could not match/i)?.length,1,
  'with no answer recorded at all the box still explains itself');

// An answer we cannot read still explains itself and still offers the way out.
const unknown=report({message:'This answer means nothing to the practice'});
assert.equal(unknown.problems.length,1);
assert.match(unknown.problems[0],/could not match/i);
assert.match(unknown.problems[0],/send it again/i);
assert.equal(unknown.field,'');

// A payer number alone is enough to explain how it goes back out, even with no message to read.
assert.match(report({payerControlNumber:'123456700009'}).resend.words,/replacement \(code 7\)/);

// Where the corrected claim goes: the payer's claim number decides the frequency code. This is
// the same rule the 837P builder and the server's linked-claim checks use.
const pureRejection=claimResendPlan({status:'rejected',payer_control_number:''});
assert.deepEqual({code:pureRejection.code,frequency:pureRejection.frequency,kind:pureRejection.kind},{code:'1',frequency:'original',kind:'new'});
assert.match(pureRejection.words,/new claim \(code 1\)/);
const denied=claimResendPlan({status:'rejected',payer_control_number:'123456700001'});
assert.deepEqual({code:denied.code,frequency:denied.frequency,kind:denied.kind},{code:'7',frequency:'replacement',kind:'replacement'});
assert.equal(denied.payerControlNumber,'123456700001');
assert.match(denied.words,/replacement \(code 7\)/);
assert.match(denied.words,/123456700001/);
assert.equal(claimResendPlan({status:'denied',payer_control_number:'  9  '}).code,'7','a payer number of spaces only is no payer number');
assert.equal(report({message:'2377 Invalid Subscriber ID'}).resend.code,'1','a clearinghouse rejection goes back as a new claim');
assert.equal(report({message:'26 Not eligible',payerControlNumber:'123456700002'}).resend.code,'7','a payer denial goes back as a replacement');
assert.match(report({message:'26 Not eligible',payerControlNumber:'123456700002'}).resend.words,/claim number 123456700002/);

// Where each fix happens: a box on the claim form, the insurance in the chart, or a plain line
// saying the fix is outside SunCharts. A claim is a frozen copy of what went out, so the module
// must never pretend a chart-side fix can be typed onto the claim.
const editor=fs.readFileSync('web/claims.js','utf8');
// The claim editor's own field names, read from the form it renders, so a focus target that does
// not exist fails here rather than silently focusing nothing.
const editorFields=new Set([...editor.matchAll(/(?:billingField|selectField)\('([a-z_0-9]+)'/g)].map(m=>m[1]));
// The diagnosis list is a picker with its own hidden field of the same name.
if(/claimDiagnosisPickerMarkup\(/.test(editor)&&/name="diagnosis_codes"/.test(fs.readFileSync(path.join(__dirname,'../web/claims.js'),'utf8')))editorFields.add('diagnosis_codes');
for(const key of ['billing_provider_name','billing_npi','rendering_npi','tax_id','billing_address','patient_address','subscriber_address','subscriber_birth_date','place_of_service','diagnosis_codes']){
 assert.ok(editorFields.has(key),`the claim editor renders ${key}`);
}
// A diagnosis fix lands on the per-line tick boxes, which are named `diagnosis_line_<n>` and are no
// longer a hand-typed `pointer_<n>` box.
assert.match(editor,/name="diagnosis_line_\$\{index\}"/,'the claim editor renders a diagnosis tick box per charge line');
assert.doesNotMatch(editor,/pointer_\$\{i\}/,'no hand-typed pointer box is left on the claim editor');
const memberFix=claimFixPlan(cameBack({memberId:'SYN-MEMBER-9'}).claim,'member_id');
assert.equal(memberFix.open,'insurance','the member ID is fixed on the insurance, not on the claim');
assert.equal(memberFix.focus,'','there is no member ID box on the claim form to focus');
assert.match(memberFix.notice,/not typed into the claim/i);
assert.match(memberFix.notice,/SYN-MEMBER-9/,'staff are told which number the claim carries');
assert.match(memberFix.notice,/send it again/i);
assert.equal(memberFix.resend.code,'1');
assert.match(claimFixPlan(cameBack({memberId:''}).claim,'member_id').notice,/no member ID/i);
assert.equal(claimFixPlan(cameBack().claim,'subscriber').open,'insurance');
assert.match(claimFixPlan(cameBack().claim,'subscriber').notice,/come from the insurance/i);
assert.equal(claimFixPlan(cameBack().claim,'tax_id').focus,'tax_id');
assert.equal(claimFixPlan(cameBack().claim,'tax_id').open,'','a tax ID really is on the claim form');
assert.equal(claimFixPlan(cameBack().claim,'rendering_npi').focus,'rendering_npi');
assert.equal(claimFixPlan(cameBack().claim,'diagnosis_pointer').focus,'diagnosis_codes','the fix lands on the diagnosis list');
assert.match(claimFixPlan(cameBack().claim,'diagnosis_pointer').notice,/a box for each charge line/i);
assert.match(editor,/name="diagnosis_line_\$\{index\}"/,'the editor renders one diagnosis tick box per charge line');
assert.equal(claimFixPlan(cameBack().claim,'timely_filing').focus,'','an insurer-side problem has no box to focus');
assert.equal(claimFixPlan(cameBack().claim,'prior_authorization').focus,'');
assert.match(claimFixPlan(cameBack().claim,'prior_authorization').notice,/nowhere in SunCharts/i,'no invented box for a number we do not store');
// Every focus the module offers is a box the editor really renders.
const problemsModule=require(path.join(process.cwd(),'web/claim-problems.js'));
assert.ok(Object.keys(problemsModule.claimProblemFields).length>=8,'the module knows where each common fix lives');
for(const [key,field] of Object.entries(problemsModule.claimProblemFields)){
 if(!field.input)continue;
 assert.ok(editorFields.has(field.input),`${key}: ${field.input} is not a claim editor field`);
}
for(const key of ['member_id','subscriber','prior_authorization','coding']){
 assert.equal(problemsModule.claimProblemFields[key].input,'',`${key} has no box on the claim form`);
}

// The box itself: staff wording, the one button, and nothing invented.
const boxReport=report({message:'2377 Invalid Subscriber ID',memberId:'BAD ID'});
const box=claimProblemBoxMarkup(boxReport,'2377 Invalid Subscriber ID','claim');
assert.match(box,/Why it came back/);
assert.match(box,/data-claim-fix-resend/);
assert.match(box,/>Fix and resend</);
assert.match(box,/data-claim-fix-field="member_id"/);
assert.match(box,/data-claim-fix-claim="claim"/);
assert.match(box,/The message as it came in/);
assert.match(claimProblemBoxMarkup(report({message:'29 Timely filing'}),'','claim'),/appeal/);
assert.equal(claimProblemBoxMarkup(null,'','claim'),'','nothing to explain, nothing drawn');
// The box escapes everything it did not write itself, exactly as every other screen in the app
// does. The test escaper mirrors app.js, so markup arriving from the insurer, from a claim number,
// or from a member ID typed onto the practice's own coverage cannot open a tag.
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
context.esc=escape;
const hostileMember=cameBack({memberId:'"><script>alert(1)</script>',message:'2377 Invalid Subscriber ID'});
const escaping=claimProblemBoxMarkup(claimProblemReport(hostileMember.claim,hostileMember.detail),'<img src=x onerror=1>','claim"><b>');
assert.doesNotMatch(escaping,/<script>/);
assert.doesNotMatch(escaping,/<img/);
assert.doesNotMatch(escaping,/<b>/);
assert.ok(escaping.includes('&lt;script&gt;'),'the text is kept, not dropped');
assert.match(escaping,/data-claim-fix-field="member_id"/,'the fix is still offered when the value needed escaping');
assert.match(escaping,/data-claim-fix-claim="claim&quot;&gt;&lt;b&gt;"/,'a claim number is escaped as an attribute too');
context.esc=value=>String(value??'');

// No identifier of the patient may be echoed back out of response text: a member ID is only ever
// read off the claim's own coverage, where staff can compare it with the card in front of them.
const leaky=report({message:'Coverage not in effect for SYN-MRN and SYN-MEMBER-1',memberId:'SYN-MEMBER-1'});
assert.match(leaky.words,/not covered on the date of service/i);
assert.doesNotMatch(leaky.words,/SYN-MRN|SYN-MEMBER-1/,`response text is never repeated back: ${leaky.words}`);
// A member ID with nothing on it says so rather than quoting a blank.
assert.match(report({memberId:'',message:'2377 Invalid Subscriber ID'}).problems[0],/no member ID/i);
// The claim's own coverage value is the only identifier the box can name.
assert.match(report({memberId:'SYN-MEMBER-2',message:'2377 Invalid Subscriber ID'}).words,/SYN-MEMBER-2/);
assert.match(report({memberId:'X',message:'2377 Invalid Subscriber ID'}).words,/too short/i);

// The module is loaded before claims.js, is served, and claims.js uses it.
const index=fs.readFileSync('web/index.html','utf8');
assert.match(index,/<script src="\/claim-problems\.js" defer><\/script><script src="\/claims\.js" defer>/,'claim-problems.js loads immediately before claims.js');
const lib=fs.readFileSync('src/lib.rs','utf8');
assert.match(lib,/include_str!\("\.\.\/web\/claim-problems\.js"\)/,'claim-problems.js is served by the engine');
assert.match(editor,/claimProblemReport\(claim,detail\)/,'the claim screen asks the module what came back');
assert.match(editor,/beginClaimFix/,'"Fix and resend" opens the claim for editing');
assert.doesNotMatch(editor,/throw new Error\([^)]*(?:cannot be fixed|not allowed to)/,'nothing hard-stops staff from fixing a claim');

// The box and the resend path are reachable from the claim screen's own click handling.
assert.match(editor,/'data-claim-fix-resend'/,'the button belongs to the claim screen');

// A CommonJS copy of the same file keeps the tests honest about the module having no DOM needs.
const required=require(path.join(process.cwd(),'web/claim-problems.js'));
assert.equal(typeof required.claimProblemReport,'function');
assert.equal(required.claimResendPlan({status:'rejected',payer_control_number:'ICN1'}).code,'7');

console.log('PASS a claim that came back explains itself in plain words, names the likely fix, and resends with the frequency code the payer already has or a new claim');
