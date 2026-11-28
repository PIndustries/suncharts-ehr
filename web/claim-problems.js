// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Translating a clearinghouse or payer answer into plain words for clinic staff, and working out
// how the corrected claim has to go back out. Pure: it reads a claim and the responses already
// loaded with it, then returns words and codes. It draws nothing, fetches nothing and never stops
// anybody from continuing. An answer it does not recognise is shown as it came, with the usual
// next step, so a new payer message costs a sentence here rather than a blocked claim screen.

// The field the fix belongs in, named the way staff see it. `input` is the box on the claim form;
// where there is no such box, `claimFixPlan` says where the record really lives.
const claimProblemFields={
  member_id:{name:'Member ID',input:''},
  subscriber:{name:'policy holder details',input:''},
  subscriber_address:{name:"policy holder's address",input:'subscriber_address'},
  subscriber_birth_date:{name:"policy holder's date of birth",input:'subscriber_birth_date'},
  billing_npi:{name:'billing NPI',input:'billing_npi'},
  rendering_npi:{name:'rendering NPI',input:'rendering_npi'},
  tax_id:{name:'tax ID',input:'tax_id'},
  billing_provider_name:{name:'billing provider name',input:'billing_provider_name'},
  billing_address:{name:'billing address',input:'billing_address'},
  diagnosis_codes:{name:'diagnosis codes',input:'diagnosis_codes'},
  // Each charge line ticks the diagnoses that apply to it. A pointer problem is about those ticks,
  // so it focuses the diagnosis list above them and the notice points at the line boxes.
  diagnosis_pointer:{name:'diagnosis pointers',input:'diagnosis_codes'},
  place_of_service:{name:'place of service',input:'place_of_service'},
  prior_authorization:{name:'prior authorization number',input:''},
  coding:{name:'the procedure code on that line',input:''}
};

// What each common answer sounds like. Checked against the payer's and clearinghouse's own
// wording, so a phrased-differently message simply does not match and the general wording is used.
const claimProblemPhrases={
  submitter_approval:['submitter not approved for electronic claim submissions on behalf of this entity'],
  member_id:['invalid subscriber id','invalid member id','invalid patient identifier','member id not found','subscriber id not found','member not found','patient not found on file','unrecognized member','unrecognised member','invalid insured id','id not found','subscriber id','member id'],
  subscriber:['subscriber mismatch','insured does not match','subscriber does not match','does not match subscriber','inconsistent subscriber','dependent does not match','insured identity','subscriber name does not match','name does not match the insured','date of birth does not match','insured date of birth'],
  diagnosis_pointer:['diagnosis pointer','diagnosis reference','dx pointer','missing diagnosis','no diagnosis','diagnosis required','invalid diagnosis','diagnosis code invalid','diagnosis is required','at least one diagnosis'],
  npi:['invalid npi','npi is invalid','npi required','missing npi','npi missing','npi not found','provider npi is invalid','rendering provider npi','billing provider npi','npi number is invalid','taxonomy'],
  tax_id:['tax id invalid','tax id missing','tax id is invalid','tax id not found','tax id does not match','tax identification','invalid taxpayer','taxpayer identification','ein is invalid','ein invalid','npi/tax id combination'],
  duplicate:['duplicate claim','already submitted','already billed','already processed','previously paid','duplicate billing','duplicate service','already on file','claim already received'],
  timely_filing:['timely filing','timely filing limit','past the filing','outside the filing','filing limit','beyond the filing deadline','expired filing','filed after the deadline'],
  no_authorization:['prior authorization','prior authorisation','preauthorization','pre-authorisation','pre auth','authorization required','authorisation required','approval required','referral required','no authorization on file','auth number'],
  not_eligible:['not eligible','eligibility could not be determined','coverage not in effect','no coverage on file','coverage terminated','coverage expired','policy not in effect','inactive coverage','terminated on','no active coverage','coverage begin date','discharged from coverage'],
  coding:['procedure code invalid','invalid procedure','invalid cpt','invalid hcpcs','code not covered','non-covered service','noncovered service','not a covered','unbundled','invalid modifier','modifier not valid','service code invalid']
};

function claimProblemText(value){return String(value??'').replace(/\s+/g,' ').trim();}
function claimProblemQuote(value){
  const text=claimProblemText(value);
  return text?`“${text.length>30?`${text.slice(0,29)}…`:text}”`:'is blank';
}
function claimProblemObject(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function claimProblemCoverage(claim){
  const snapshot=claimProblemObject(claim?.snapshot);
  const account=claimProblemObject(snapshot.account);
  const coverage=claimProblemObject(account.coverage_snapshot);
  return claimProblemObject(claimProblemObject(coverage.coverage).content);
}
// One lower-case block of everything the responses actually say. Member IDs, names and record
// numbers are left out of it — an identifier is never searched or echoed back from response
// text, only read off the claim's own coverage when a rule needs it.
// Keys whose values are patient identity, a frozen document body or an address: none of them is ever
// wording from the insurer.
const claimProblemSkipKeys=/^(patient|patients|patient_name|patient_id|mrn|member_id|ins_number|subscriber_number|given_name|family_name|first_name|last_name|middle_name|full_name|birth_date|date_of_birth|dob|content|snapshot|document|original_text|document_text|address|email|phone)$/i;
// On the claim's own record, `notes` and `reason` are things staff wrote to themselves - why they
// prepared the claim, what they think about it - never an answer from the payer. On a revision row the
// same keys hold the answer that came back, so the two are told apart rather than trusted alike.
const claimProblemOwnWordsKeys=/^(note|notes|reason)$/;
function claimProblemEvidenceText(sources){
  const found=[];
  const add=(value,isPracticeRecord)=>{
    if(value==null||value===''||value===false)return;
    if(typeof value==='string'||typeof value==='number'){const text=claimProblemText(value).toLowerCase();if(text)found.push(text);return;}
    if(Array.isArray(value)){value.forEach(entry=>add(entry,isPracticeRecord));return;}
    if(typeof value!=='object')return;
    const ownWords=!!value.claim_record, recordedAnswer=!!value.recorded_answer;
    for(const[key,nested]of Object.entries(value)){
      if(claimProblemSkipKeys.test(key))continue;
      if(key==='recorded_answer'||key==='claim_record')continue;
      if(ownWords&&!recordedAnswer&&claimProblemOwnWordsKeys.test(key))continue;
      add(nested,ownWords||isPracticeRecord);
    }
  };
  (sources||[]).forEach(entry=>add(entry,false));
  return found.join(' · ');
}
function claimProblemIncludesAny(evidence,needles){
  const haystack=claimProblemText(evidence);
  if(!haystack)return false;
  return needles.some(needle=>haystack.includes(needle));
}
// A short, display-only reason from a matched response. Unfamiliar provider wording stays a quote.
function claimProblemWorklistReason(message){
  if(typeof message!=='string')return '';
  const text=claimProblemText(message.replace(/[\p{Cc}\p{Cf}]/gu,' '));
  const code=/^(Code [A-Z0-9]{1,8})\s*[-–—:]/i.exec(text)?.[1];
  if(claimProblemIncludesAny(text.toLowerCase(),claimProblemPhrases.submitter_approval)){
    const subject=/\bbilling provider\b/i.test(text)?' for this billing provider':' for electronic claims';
    return `${code?code+' · ':''}Submitter not approved${subject}`;
  }
  const pairing=/^NCCI\s*-\s*procedure code \[([a-z0-9]{5})\] requires an appropriate modifier when procedure \[([a-z0-9]{5})\] present\.?$/i.exec(text);
  if(pairing)return `${pairing[1]} needs a modifier when billed with ${pairing[2]}`;
  const characters=Array.from(text);
  return characters.length>160?`${characters.slice(0,159).join('').trimEnd()}…`:text;
}
function claimProblemMemberId(claim){return claimProblemText(claimProblemCoverage(claim).member_id);}
// True when the claim on screen really carries data — the draft-claim case, where nothing has
// been filled in yet, must not be reported as a blank member ID.
function claimProblemHasContent(claim){
  if(!claim||typeof claim!=='object')return false;
  if(Object.keys(claimProblemObject(claim.content)).length)return true;
  const snapshot=claimProblemObject(claim.snapshot);
  return !!(snapshot.account||snapshot.patient);
}
function claimProblemDuplicateWords(claim){
  const number=claimProblemText(claim?.payer_control_number);
  return `The insurer already has a claim for these charges, so this one came back as a duplicate. Check the payments already posted for this encounter before sending anything again.${number?` Their claim number is ${number}; a corrected claim has to go as a replacement carrying that number.`:' If this really is a corrected claim, it needs the insurer’s claim number from the first answer.'}`;
}
function claimProblemEligibilityWords(claim){
  const coverage=claimProblemCoverage(claim);
  const end=claimProblemText(coverage.termination_date||coverage.term_date||coverage.end_date);
  return `The insurer says this patient was not covered on the date of service.${end?` The coverage recorded here ends ${end}.`:''} Check the plan’s dates and the member ID against the card, then send it again.`;
}
// The reasons worth naming, in the order they are tried. Each returns its words when it is the
// problem on screen and an empty string when it is not.
const claimProblemRecognisers=[
  {key:'member_id_missing',field:'member_id',say(claim,evidence){
    if(!claimProblemHasContent(claim))return '';
    if(claimProblemMemberId(claim))return '';
    return 'The insurer could not find this patient because there is no member ID on the claim. Copy it from the front of the card into Insurance in the patient chart.';
  }},
  {key:'member_id_short',field:'member_id',say(claim){
    const member=claimProblemMemberId(claim);
    if(!member||member.length>1)return '';
    return `The member ID on the claim (“${member}”) is too short to be the one on the card. Copy it from the card exactly, including any letters.`;
  }},
  {key:'member_id',field:'member_id',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.member_id))return '';
    const member=claimProblemMemberId(claim);
    return `The insurer does not recognise the member ID on the claim (${claimProblemQuote(member)}). Check it against the card, including letter case, spaces and any leading zeros.`;
  }},
  {key:'subscriber_mismatch',field:'subscriber',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.subscriber))return '';
    return 'The insurer says the policy holder on this claim is not who they have on the plan. Check who the policy holder is against the card, then fix the name, date of birth and address.';
  }},
  {key:'not_eligible',field:'member_id',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.not_eligible))return '';
    return claimProblemEligibilityWords(claim);
  }},
  {key:'timely_filing',field:'',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.timely_filing))return '';
    return 'The insurer says this claim arrived after the deadline for the date of service. Check how long this plan allows and use the plan’s appeal route — sending the same claim again does not lift the deadline.';
  }},
  {key:'no_authorization',field:'prior_authorization',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.no_authorization))return '';
    return 'This plan needed an approval or referral that is not on the claim. Add the authorization number to the claim, or follow the plan’s rules for a service approved after the encounter.';
  }},
  {key:'duplicate',field:'',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.duplicate))return '';
    return claimProblemDuplicateWords(claim);
  }},
  {key:'tax_id',field:'tax_id',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.tax_id))return '';
    return 'The practice’s tax ID on this claim is missing or not the nine digits the insurer expects. Check it against the practice’s billing setup.';
  }},
  {key:'npi',field:'billing_npi',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.npi))return '';
    return 'The claim needs a valid 10-digit NPI and the one on it is missing or wrong. Check the billing and rendering NPIs against the provider’s record.';
  }},
  {key:'diagnosis_pointer',field:'diagnosis_pointer',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.diagnosis_pointer))return '';
    return 'Each charge line has to point at the diagnosis or diagnoses that explain it. Open the claim, set the diagnoses that apply to each line, and make the first one the main reason for the encounter.';
  }},
  {key:'coding',field:'coding',say(claim,evidence){
    if(!claimProblemIncludesAny(evidence,claimProblemPhrases.coding))return '';
    return 'The insurer will not pay the procedure code or a modifier on one of the lines. Check the code and its modifiers against what was actually done at the encounter.';
  }}
];

// How the corrected claim goes back out. A claim the payer already took (their claim number is on
// it) must go back as a replacement, code 7, referring to that number. One the clearinghouse
// bounced before the payer took it on goes back as a new claim, code 1. This is the same rule the
// 837P builder and the server's own linked-claim checks apply.
function claimResendPlan(claim){
  const payerControl=claimProblemText(claim?.payer_control_number);
  if(payerControl){
    return{kind:'replacement',code:'7',frequency:'replacement',payerControlNumber:payerControl,
      words:`The payer took this claim and gave it claim number ${payerControl}, so the corrected claim goes back as a replacement (code 7) that refers to that number.`};
  }
  return{kind:'new',code:'1',frequency:'original',payerControlNumber:'',
    words:'The clearinghouse sent this claim back before the payer took it on, so nothing is on file with them. It goes back as a new claim (code 1) once the problem is put right.'};
}

// Every response text that travels with the claim, in the order staff would read it.
function claimProblemSources(claim,detail={}){
  const tracking=claimProblemObject(detail.tracking);
  const reports=Array.isArray(tracking.reports)?tracking.reports:[];
  // The recorded answers come from the claim detail itself, so the box and the history panel read the
  // same rows; the history endpoint is used when it was fetched separately.
  const revisions=[
    ...(Array.isArray(detail.responses?.revisions)?detail.responses.revisions:[]),
    ...(Array.isArray(detail.history?.items)?detail.history.items:[]),
  ];
  return [
    claim?.response,claim?.rejection,claim?.denial,
    // The claim's own content is the practice's record; its notes and reason are not an answer from
    // anybody, so they are marked and left out of the wording search.
    {claim_record:true,content:claim?.content},
    tracking.response,tracking.rejection,tracking.denial,
    reports.map(report=>{
      const evidence=claimProblemObject(report?.evidence);
      return{status:evidence.status,sender:evidence.senderid,sender_name:evidence.sender_name,message:evidence.message};
    }),
    (detail.responses?.feed||[]).map(entry=>({status:entry?.status,sender:entry?.sender,message:entry?.message})),
    // A revision row carries the payer's or clearinghouse's own message, or the words staff typed when
    // they recorded the answer - and on a denial taken over the phone those words are all there is.
    revisions.map(entry=>({recorded_answer:true,message:entry?.message,reason:entry?.reason,evidence:entry?.evidence}))
  ];
}

// The plain-words box for a claim that came back, or null when there is nothing to explain (the
// claim is not a rejected/denied one, or no response has been recorded yet).
function claimProblemReport(claim,detail={}){
  if(!claim||typeof claim!=='object')return null;
  const status=claimProblemText(claim.status).toLowerCase();
  if(!['rejected','denied','returned'].includes(status))return null;
  // A crossover claim was never sent from here: the practice has no corrected claim to prepare, so
  // a "fix and resend" box would promise a button that cannot exist.
  if(claim.crossover_tracking_only===true||claimProblemObject(claim.snapshot?.coordination_of_benefits).crossover)return null;
  const evidence=claimProblemEvidenceText(claimProblemSources(claim,detail));
  const problems=[];
  for(const recogniser of claimProblemRecognisers){
    let words='';
    try{words=claimProblemText(recogniser.say(claim,evidence));}catch{words='';}
    if(!words||problems.some(problem=>problem.words===words))continue;
    problems.push({key:recogniser.key,words,field:recogniser.field||''});
    if(problems.length===2)break;
  }
  if(!problems.length){
    problems.push({key:'unrecognised',field:'',words:'We could not match this answer to a fix we know. The message is shown below exactly as it came in. Open the claim, put right whatever the answer names, and send it again — or leave it and ask the insurer.'});
  }
  const field=problems.map(problem=>problem.field).find(name=>name&&claimProblemFields[name])||'';
  return{
    status,
    problems:problems.map(problem=>problem.words),
    field,
    fieldLabel:claimProblemFields[field]?.name||'',
    words:problems.map(problem=>problem.words).join(' '),
    resend:claimResendPlan(claim),
    note:'Nothing here stops you: you can save what you have and come back, or send it as it stands once you have checked it.'
  };
}

// The box itself. `raw` is the response wording already shown elsewhere on the screen; it is
// repeated here only so the plain words and the message sit together. `claimId` is our own claim
// identifier, never a patient one.
function claimProblemBoxMarkup(report,raw='',claimId=''){
  if(!report)return '';
  const sentences=report.problems.map(words=>`<p>${esc(words)}</p>`).join('');
  const target=report.field?` data-claim-fix-field="${esc(report.field)}"`:'';
  const claim=claimId?` data-claim-fix-claim="${esc(claimId)}"`:'';
  return `<section class="claim-problem-box" data-claim-problem-box aria-label="Why it came back"><h3>Why it came back</h3>${sentences}<p class="muted">${esc(report.resend.words)}</p><button type="button" class="primary" data-claim-fix-resend${target}${claim}>Fix and resend</button><p class="muted">${esc(report.note)}</p>${raw?`<details class="amendment"><summary>The message as it came in</summary><p>${esc(raw)}</p></details>`:''}</section>`;
}

// The fix target: what box to focus, where else the fix belongs, what to tell staff, and how the
// corrected claim goes back out. The words and the frequency code come from one place, so the
// screen cannot promise one and send the other.
//
// `focus` is a box on the claim form itself. `open` is an editor somewhere else that SunCharts can
// open straight away. `where` names a place staff have to go themselves, because the claim itself
// is a frozen copy of what was sent and the record to put right lives in the chart.
function claimFixPlan(claim,field){
  const plan=claimResendPlan(claim);
  const known=claimProblemFields[field]||{};
  const member=claimProblemMemberId(claim);
  if(field==='member_id')return{focus:'',open:'insurance',where:'',notice:member?`The member ID is not typed into the claim: the claim carries the number that was on the insurance when it was prepared, and here it reads “${member}”. Check that against the card and save it, then bring the claim up to date and send it again.`:'There is no member ID on this insurance yet. Add it to the insurance, then bring the claim up to date and send it again.',resend:plan};
  if(field==='subscriber')return{focus:'',open:'insurance',where:'',notice:'The policy holder’s name, date of birth and relationship come from the insurance, not from this form. Put them right there, then bring the claim up to date and send it again.',resend:plan};
  if(field==='diagnosis_pointer')return{focus:'diagnosis_codes',open:'',where:'',diagnosis:true,notice:'There is a box for each charge line under the diagnosis list. Tick the diagnoses that apply to that line, and tick the main reason for it first.',resend:plan};
  if(field==='prior_authorization')return{focus:'',open:'',where:'the Prior authorization number under the procedures on the encounter’s Billing',notice:'Add the approval number in Prior authorization number under the procedures on the encounter’s Billing, then send a corrected claim.',resend:plan};
  return{focus:known.input||'',open:'',where:'',notice:'',resend:plan};
}

if(typeof module!=='undefined'&&module.exports)module.exports={claimProblemReport,claimResendPlan,claimProblemBoxMarkup,claimFixPlan,claimProblemText,claimProblemFields,claimProblemPhrases};
