// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// "What happened" for one claim: everything Claim.MD, the clearinghouse and the
// payer have told us, in one plain-English list with dates. The builder is pure —
// it takes the claim data the claim screen already loads and returns a plain
// object — so scripts/test_claim_timeline_ui.cjs can check it without a browser.
// Codes are always shown with their meaning; raw JSON never reaches staff except
// inside a "technical details" disclosure.

const timelineClaimMdStageLabels=Object.freeze({
 A0:'Received by Claim.MD',A1:'Sent to the insurance company',A2:'Accepted by the insurance company',
 A3:'Rejected by the insurance company',A4:'Denied by the insurance company',A5:'Adjudicated by the insurance company',
 A6:'Returned as unprocessable',A7:'Cancelled',A8:'No response received'
});
// 277CA claim status categories (claim status information).
const timelineCa277CategoryLabels=Object.freeze({
 A0:'Claim status',A1:'Claim received',A2:'Claim accepted for processing',A3:'Claim rejected',
 A4:'Claim denied',A5:'Claim adjudicated',A6:'Claim returned as unprocessable',A7:'Claim cancelled',
 A8:'No response from the payer'
});
const timelineCa277ActionLabels=Object.freeze({
 WQ:'Waiting for a response from the payer',KB:'Acknowledged, no further action',KH:'Hold - action needed from us',
 KM:'Corrected claim already sent',KN:'New original claim sent',KP:'Proof of mailing provided',
 KQ:'Proof of delivery provided',KR:'Reissued and resubmitted',KZ:'Response will follow'
});
// Group/pricing scheme (CARC qualifier) and the commonest claim adjustment reason
// codes. An unknown code is still shown, with the code, never as a bare mystery.
const timelineEraGroupLabels=Object.freeze({CO:'Contractual adjustment',CR:'Correction and reversal',OA:'Other adjustment',PI:'Payer initiated reduction',PR:'Patient responsibility',BL:'Basis of limitation',UW:'Unallowable'});
const timelineEraReasonLabels=Object.freeze({
 1:'Deductible amount',2:'Coinsurance amount',3:'Co-payment amount',4:'Dollar amount not covered',
 23:'The claim or service is not covered under this plan',
 26:'Charges are from a non-participating provider',
 27:'Expenses exceed the plan allowance for this service',
 45:'Charge exceeds the fee schedule',
 49:'Claim paid at the percentage allowed by the plan',
 50:'Not a covered service under the plan',
 51:'Not the plan for this patient on this date',
 52:'Service not covered for this patient on this date',
 60:'This service is paid under a different benefit category',
 96:'Claim information is incomplete or incorrect',
 109:'The claim is not eligible for payment under this plan',
 151:'Original claim payment is being reversed or adjusted',
 152:'Adjustment because of a prior decision, appeal or reimbursement',
 234:'The claim was processed as primary under another plan',
 253:'Service was paid to another provider',
 258:'This service is paid only once per benefit period'
});
const timelineEraClaimStatusLabels=Object.freeze({
 1:'Claim reviewed and paid',2:'Claim reviewed and no payment made',7:'Written explanation issued to the patient',
 8:'Requiring further review or pending',9:'Requiring corrective action and resubmission',
 10:'Can be reopened after initial adjudication',20:'Requiring additional documentation',
 21:'Claim adjustment, reversal due to prior overpayment or underpayment',22:'Reversal of prior payment'
});
const timelineRecordKindLabels=Object.freeze({
 uploaded_file:'Claim file received by Claim.MD',modification:'Change made on the Claim.MD website',
 note:'Note added on the Claim.MD website',archive:'Archived in Claim.MD'
});
// Fields staff read, per Claim.MD record kind. Anything not listed still appears in
// the technical disclosure, so nothing received from the provider is lost.
// Exposed as timelineRecordFields for the Claim.MD activity tables, which use the same order.
const timelineRecordFields=globalThis.timelineRecordFields=Object.freeze({
 uploaded_file:[['filename','File'],['file_name','File'],['claimid','Claim number on the claim file'],['pcn','Patient control number'],['upload_date','Uploaded on'],['submitter_id','Submitted by'],['batchid','Batch'],['fileid','Claim.MD file ID'],['claim_count','Claims in the file'],['claimmd_id','Claim.MD claim ID'],['status','Status']],
 modification:[['modid','Claim.MD change ID'],['modifydate','Date of the change'],['modtime','Time of the change'],['user','Changed by'],['field','What was changed'],['old_value','Before'],['new_value','After'],['claimmd_id','Claim.MD claim ID'],['claimid','Claim number'],['pcn','Patient control number'],['status','Status']],
 note:[['noteid','Claim.MD note ID'],['notedate','Date of the note'],['notetime','Time of the note'],['user','Written by'],['note','Note'],['claimmd_id','Claim.MD claim ID'],['claimid','Claim number'],['pcn','Patient control number']],
 archive:[['claim_ids','Claims archived'],['count','Claims archived'],['status','Result']]
});
// Outcomes we can name in words. Anything else keeps its own code, because guessing
// at a payer's meaning is worse than showing the code with its label.
const timelineValueLabels=Object.freeze({
 A:'Accepted',R:'Rejected',accepted:'Accepted',rejected:'Rejected',pending:'Waiting for a response',
 delivered:'Received',prepared:'Prepared but not confirmed as received',cancelled:'Cancelled',needs_review:'Needs review',
 partial:'Partly accepted',T:'Test',P:'Live',true:'Yes',false:'No',Y:'Yes',N:'No'
});
// A machine field name becomes a readable label. Known names win; anything else
// becomes sentence case so staff never see "bill_taxid".
function timelineFieldLabel(field){
 const key=String(field??'');
 const known=timelineRecordFieldLabels[key];if(known)return known;
 const words=key.replace(/[_]+/g,' ').trim();
 return words?words[0].toUpperCase()+words.slice(1):'Detail';
}
// Every provider field staff may see, with the words we show for it. The per-kind
// lists above decide the order; this table supplies the label.
const timelineRecordFieldLabels=Object.freeze({
 id:'ID',claim_id:'SunCharts claim',claimmd_id:'Claim.MD claim ID',kind:'Record type',remote_id:'Provider record ID',
 patient_control_number:'Patient control number',recorded_at:'Recorded at',content:'Provider data',reason:'Reason',actor_id:'Recorded by',
 setting_id:'Claim.MD connection',created_at:'Created',updated_at:'Updated',filename:'File',file_name:'File',fileid:'Claim.MD file ID',
 upload_date:'Uploaded on',uploaded_at:'Uploaded on',submitter_id:'Submitted by',batchid:'Batch',claim_count:'Claims in the file',
 modid:'Claim.MD change ID',modifydate:'Date of the change',modtime:'Time of the change',user:'Person',field:'What was changed',
 old_value:'Before',new_value:'After',noteid:'Claim.MD note ID',notedate:'Date of the note',notetime:'Time of the note',note:'Note',
 claimid:'Claim number',pcn:'Patient control number',status:'Status',claim_ids:'Claims archived',count:'Number of claims',
 transmit_date:'Date sent',claim_form:'Claim form',page:'Page',payload_hash:'File fingerprint',original_x12:'Original file contents',
 bill_npi:'Billing NPI',bill_taxid:'Billing tax ID',payerid:'Payer ID',request_id:'Request ID',request:'Request',external_url:'Link at Claim.MD',
 eraid:'Claim.MD ERA ID',era_documents:'ERA evidence',operations:'Sessions started',webhook_events:'Signed events',operations_read_at:'Read at',
 account_number:'Claim.MD account',event_id:'Event ID',batch_id:'Batch ID',payload:'Event contents',received_at:'Received at',
 claimid_type:'Claim number type',usage:'Account mode',label:'Connection',last_test_at:'Last connection check',partner_id:'Clearinghouse connection',
 route_key:'Connection route',partner_version:'Connection version',credential_revision:'Key revision',configured:'Configured',connected:'Connected',
 active:'Active connection',connections:'Connections',provider:'Provider',paused:'Paused',last_poll_at:'Last checked',last_success_at:'Last successful check',
 next_poll_at:'Next check',last_result:'Last result',technical_status:'Format check (999)',payer_outcome:'Payer response',
 submitted_at:'Submitted at',transmitted_at:'Transmitted at',acknowledged_at:'Acknowledged at',paid_cents:'Paid',paid_amount:'Paid'
});
// A stored value turned into words: booleans, Y/N flags and the status letters Claim.MD uses.
function timelineValueText(value){
 if(value===null||value===undefined||value==='')return '';
 if(typeof value==='boolean')return value?'Yes':'No';
 const key=String(value);
 return Object.prototype.hasOwnProperty.call(timelineValueLabels,key)?timelineValueLabels[key]:key;
}
// One labelled field from provider data. Returns null when the field carries nothing to show.
function timelineFieldRow(field,value,label,technical){
 if(value===undefined||value===null||value==='')return null;
 if(typeof value==='object')return null;
 const text=timelineValueText(value);
 if(!text)return null;
 return {label:label||timelineFieldLabel(field),value:text,raw:`${field}: ${technical!==undefined?technical:String(value)}`};
}
// Every field of provider data, in a sensible order, as labelled rows. Fields whose
// meaning we know are labelled and put first; anything else is still shown, sentence-
// cased, so nothing received from the provider is quietly hidden.
function timelineProviderRows(content,preferred){
 const values=content&&typeof content==='object'&&!Array.isArray(content)?content:{},seen=new Set(),rows=[];
 for(const [field,label] of preferred||[]){
  if(seen.has(field))continue;seen.add(field);
  const row=timelineFieldRow(field,values[field],label);if(row)rows.push(row);
 }
 for(const [field,value] of Object.entries(values)){
  if(seen.has(field))continue;seen.add(field);
  const row=timelineFieldRow(field,value);if(row)rows.push(row);
 }
 return rows;
}
function timelineRecordRows(record){
 const kind=String(record?.kind||'');
 // The record's own columns (which claim, who recorded it, when) come first, then the
 // provider payload in the order that reads best for this kind of record.
 // The record type, its provider ID and the timestamp are already the step heading and
 // its time, so repeating them inside the detail table would be noise.
 const head=timelineProviderRows({claimmd_id:record?.claimmd_id,patient_control_number:record?.patient_control_number},[['claimmd_id','Claim.MD claim ID'],['patient_control_number','Patient control number']]);
 return [...head,...timelineProviderRows(record?.content,timelineRecordFields[kind])];
}
// A labelled table of provider data, with the raw record kept behind a disclosure.
function timelineFieldTable(rows){
 if(!rows.length)return '<p class="muted">Nothing readable was recorded for this item.</p>';
 return `<table class="billing-table"><tbody>${rows.map(row=>`<tr><th scope="row">${esc(row.label)}</th><td>${esc(row.value)}</td></tr>`).join('')}</tbody></table>`;
}
// "More technical details" disclosure, only when there is raw data worth keeping.
function timelineTechnical(rows){
 const list=rows.filter(Boolean);
 if(!list.length)return '';
 return `<details class="amendment claim-timeline-technical"><summary>Show technical details</summary><pre class="billing-source">${esc(list.join('\n'))}</pre></details>`;
}
const timelineDayTime=/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(:\d{2})?$/;
// A date or a date with the provider's own clock. A bare date is placed at noon so a
// time-zone shift cannot move it to the previous or next day; a date with a time keeps
// that clock reading as local wall time, which is what staff compare against.
function timestampOf(value){
 if(!value)return null;
 if(value instanceof Date)return Number.isNaN(value.getTime())?null:value;
 const text=String(value),wall=timelineDayTime.exec(text);
 if(wall){const parsed=new Date(`${wall[1]}T${wall[2]}:${wall[3]}${wall[4]||':00'}`);return Number.isNaN(parsed.getTime())?null:parsed;}
 if(/^\d{4}-\d{2}-\d{2}$/.test(text)){const parsed=new Date(`${text}T12:00:00`);return Number.isNaN(parsed.getTime())?null:parsed;}
 const parsed=new Date(value);
 return Number.isNaN(parsed.getTime())?null:parsed;
}
function timelineStamp(value){
 const parsed=timestampOf(value);
 if(!parsed)return '';
 return typeof displayDateTime==='function'?displayDateTime(parsed):parsed.toISOString();
}
function timelineDate(value){
 const parsed=timestampOf(value);
 if(!parsed)return '';
 return typeof displayDate==='function'?displayDate(parsed):parsed.toISOString().slice(0,10);
}
function dayGap(from,to){
 if(!from||!to)return null;
 // Calendar days between the two dates as the person sees them, never the hour of day.
 const a=Date.UTC(from.getFullYear(),from.getMonth(),from.getDate()),b=Date.UTC(to.getFullYear(),to.getMonth(),to.getDate());
 const days=Math.round((b-a)/86400000);
 return Number.isFinite(days)&&days>=0?days:null;
}
// Claim.MD status letters: a claim is accepted by Claim.MD ("A") and then by the
// payer; "R" is a rejection. senderid "CLMMD" means the clearinghouse, not the payer.
function timelineClaimMdStatusText(evidence={}){
 const rejected=evidence.status==='R'||evidence.message?.status==='R';
 const sender=evidence.sender_name||(evidence.senderid==='CLMMD'?'Claim.MD':'the insurance company');
 if(rejected)return{accepted:false,rejected:true,who:evidence.senderid==='CLMMD'?'Claim.MD':(evidence.sender_name||'the insurance company'),message:evidence.message?.message||''};
 if(evidence.status==='A')return{accepted:true,rejected:false,who:evidence.senderid==='CLMMD'?'Claim.MD':(evidence.sender_name||'the insurance company'),message:evidence.message?.message||''};
 return{accepted:false,rejected:false,who:sender,message:evidence.message?.message||''};
}
function adjustmentLabel(adjustment={}){
 const group=String(adjustment.group||'').toUpperCase(),code=String(adjustment.reason_code||'').trim();
 const groupText=timelineEraGroupLabels[group]||'';
 const reasonText=timelineEraReasonLabels[code]||'';
 const words=[reasonText||'Adjustment',groupText?`${groupText} (${group})`:group,code?`code ${code}`:''].filter(Boolean);
 return words.join(' · ');
}
// Money, in dollars. Falls back to a plain two-decimal string outside the browser.
function timelineMoney(cents){
 if(cents===null||cents===undefined||cents==='')return '';
 if(typeof money==='function')return money(Number(cents)||0);
 return `$${(Number(cents)/100).toFixed(2)}`;
}
// The steps that happened, oldest first, each with a plain label and a date.
function buildClaimTimeline(input={}){
 const claim=input.claim||{},tracking=input.tracking||{},history=input.history?.items||input.history||[];
 const claimMdRecords=(input.claimMdRecords||[]).filter(record=>record&&typeof record==='object');
 const ca277Rows=(input.ca277Rows||[]).filter(row=>row&&typeof row==='object');
 const era=input.era&&typeof input.era==='object'?input.era:null;
 const postings=(input.postings||[]).filter(post=>post&&typeof post==='object');
 const invoices=(input.invoices||[]).filter(invoice=>invoice&&typeof invoice==='object');
 const now=timestampOf(input.now)||new Date();
 const steps=[];
 const push=step=>{const when=timestampOf(step.at);steps.push({...step,at:when?when.toISOString():null,when});};
 const payerName=path(claim,'snapshot.account.coverage_snapshot.payer.content.name')||'the insurance company';

  push({key:'created',label:'Created',at:history.length?history[history.length-1].created_at:claim.created_at,detail:`Claim ${claim.control_number||''}`.trim(),source:'suncharts'});

 for(const submission of tracking.submissions||[]){
  if(!submission||!['prepared','delivered'].includes(submission.status))continue;
  const delivered=submission.status==='delivered';
  push({key:`submission-${submission.id||steps.length}`,label:delivered?'Sent to the clearinghouse':'Claim file prepared for the clearinghouse',at:submission.created_at,
   detail:delivered?`File ${submission.interchange_control||'number not reported'}${submission.partner_name?` · ${submission.partner_name}`:''}`:'The claim file exists but Claim.MD has not confirmed receiving it.',
   rows:[timelineFieldRow('interchange_control',submission.interchange_control,'Claim file number'),timelineFieldRow('technical_status',timelineValueText(submission.technical_status),'Format check (999)',submission.technical_status),timelineFieldRow('payer_outcome',timelineValueText(submission.payer_outcome),'Payer response',submission.payer_outcome)].filter(Boolean),
   source:'suncharts'});
 }
 const externalSent=history.some(item=>item?.evidence?.action==='record_submission');
 if(externalSent)push({key:'external-sent',label:'Sent to the clearinghouse',at:history.find(item=>item?.evidence?.action==='record_submission')?.evidence?.event_date||history.find(item=>item?.evidence?.action==='record_submission')?.created_at,detail:'Staff recorded that this claim was sent outside SunCharts.',source:'staff'});

 for(const report of tracking.reports||[]){
  const evidence=report.evidence||{},status=timelineClaimMdStatusText(evidence);
  const forwarded=evidence.status==='A'&&evidence.senderid&&evidence.senderid!=='CLMMD';
  let label,detail;
  if(status.rejected)label=status.who==='Claim.MD'?'Rejected by Claim.MD':`Rejected by ${status.who}`;
  else if(forwarded)label='Forwarded to the insurance company';
  else if(status.accepted)label=evidence.senderid==='CLMMD'?'Accepted by Claim.MD':`Accepted by ${status.who}`;
  else label=`Update from ${status.who}`;
  detail=status.message||'';
  if(forwarded&&evidence.sender_icn)detail=`${detail}${detail?' ':''}Payer claim number ${evidence.sender_icn}.`;
  push({key:`report-${evidence.responseid||report.id}`,label,at:report.received_at,detail,
   rows:[timelineFieldRow('claimmd_id',evidence.claimmd_id,'Claim.MD claim ID'),timelineFieldRow('fileid',evidence.fileid,'Claim.MD file ID'),timelineFieldRow('senderid',evidence.senderid,'Sent by (code)'),timelineFieldRow('sender_name',evidence.sender_name,'Sent by'),timelineFieldRow('sender_icn',evidence.sender_icn,'Payer claim number'),timelineFieldRow('status',timelineValueText(evidence.status),'Status',evidence.status),timelineFieldRow('response_time',evidence.response_time,'Provider time'),timelineFieldRow('total_charge',evidence.total_charge,'Total charge reported by the provider'),timelineFieldRow('fdos',evidence.fdos,'Date of service reported by the provider')].filter(Boolean),
   raw:JSON.stringify(evidence,null,2),source:'claimmd'});
 }
 for(const record of claimMdRecords){
  const content=record.content||{},rows=timelineRecordRows(record);
  const at=content.modifydate||content.notedate||content.upload_date||record.recorded_at;
  const time=content.modtime||content.notetime||'';
  push({key:`claimmd-${record.kind}-${record.remote_id||record.recorded_at}`,label:timelineRecordKindLabels[record.kind]||`Claim.MD ${String(record.kind||'update').replace(/_/g,' ')}`,
   at:`${at||''}${time?`T${time}`:''}`.trim()||at,detail:content.note||content.field||'',rows,raw:JSON.stringify(record.content||{},null,2),source:'claimmd'});
 }
 for(const row of ca277Rows){
  const statuses=(row.statuses||[]).slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  for(const status of statuses){
   const category=timelineCa277CategoryLabels[status.category]||`Status category ${status.category}`;
   const action=timelineCa277ActionLabels[status.action]||'';
   const reason=status.message||'';
   push({key:`ca277-${row.control}-${status.category}-${status.code}-${status.date||''}`,
    label:`Insurance acknowledgment (277CA) · ${category}`,
    at:status.date?`${status.date}`:row.received_at,
    detail:[reason?`Reason: ${reason}`:'',action,status.entity?`From ${status.entity}`:''].filter(Boolean).join(' · '),
    rows:[timelineFieldRow('category',`${category} (${status.category})`,'Status',status.category),timelineFieldRow('code',status.code,'Status code'),timelineFieldRow('action',status.action,'Action code'),timelineFieldRow('entity',status.entity,'Sent by (code)'),timelineFieldRow('payer_control',row.payer_control,'Payer claim number'),timelineFieldRow('intermediary_control',row.intermediary_control,'Clearinghouse claim number')].filter(Boolean),
    source:'277ca'});
  }
 }
 if(era){
  const row=era.row||{},remittance=era.remittance||{};
  const adjustments=(row.adjustments||[]).map(adjustment=>adjustmentLabel(adjustment));
  push({key:`era-${remittance.id||'payment'}`,label:'Payment received (ERA)',at:remittance.payment_date||remittance.created_at,
   detail:`Paid ${timelineMoney(row.paid_cents)} · patient responsible ${timelineMoney(row.patient_responsibility_cents)}${row.status?` · payer says: ${timelineEraClaimStatusLabels[String(row.status)]||`claim status code ${row.status}`}`:''}`,
   rows:[timelineFieldRow('trace',remittance.trace,'Payment trace number'),timelineFieldRow('payment_date',timelineDate(remittance.payment_date),'Payment date',remittance.payment_date),timelineFieldRow('charged_cents',timelineMoney(row.charged_cents),'Charges on the claim'),timelineFieldRow('paid_cents',timelineMoney(row.paid_cents),'Paid by the insurance company'),timelineFieldRow('patient_responsibility_cents',timelineMoney(row.patient_responsibility_cents),'Patient responsible'),timelineFieldRow('status',timelineEraClaimStatusLabels[String(row.status)]||row.status,'Payer claim status',row.status),timelineFieldRow('payer_control_number',row.payer_control_number,'Payer claim number')].filter(Boolean),
   detailExtra:adjustments,source:'era'});
  if(String(row.status)==='22')push({key:`era-reversal-${remittance.id||'payment'}`,label:'Payment reversed',at:remittance.payment_date||remittance.created_at,detail:'The payer took back a payment previously posted for this claim.',source:'era'});
  if(remittance.status==='posted')push({key:`posted-${remittance.id||'payment'}`,label:'Posted',at:remittance.posted_at||remittance.payment_date,detail:'The insurance payment and the approved write-offs were posted to the account.',source:'suncharts'});
 }
  const isPosted=step=>String(step.key||'').startsWith('posted-');
  if(steps.some(isPosted)){
   for(const invoice of invoices){
    push({key:`invoice-${invoice.id}`,label:'Patient billed',at:invoice.created_at,detail:`Statement issued · amount due ${timelineMoney(invoice.snapshot?.amount_due_cents)}`,rows:[timelineFieldRow('amount_due_cents',timelineMoney(invoice.snapshot?.amount_due_cents),'Amount due'),timelineFieldRow('responsibility_cents',timelineMoney(invoice.snapshot?.responsibility_cents),'Patient responsible')].filter(Boolean),raw:JSON.stringify(invoice.snapshot||{},null,2),source:'suncharts',rowsSummary:'Statement details'});
   }
  }
  const withTime=steps.filter(step=>step.at).sort((a,b)=>new Date(a.at)-new Date(b.at)||String(a.label).localeCompare(String(b.label)));
  const withoutTime=steps.filter(step=>!step.at);
  const ordered=[...withTime,...withoutTime];
  const postedStep=ordered.find(isPosted),billedStep=ordered.find(step=>String(step.key||'').startsWith('invoice-'));
 return {steps:ordered,current:claimCurrentLine(claim,{tracking,era,posted:!!postedStep,postedAt:postedStep?.at||null,billed:!!billedStep,billedAt:billedStep?.at||null,now,payerName}),
  identifiers:{payerControlNumber:claim.payer_control_number||'',claimMdClaimId:claimMdClaimId(claimMdRecords,tracking),controlNumber:claim.control_number||''}};
}
function path(object,dotted){
 let node=object;
 for(const key of String(dotted).split('.')){if(node===null||node===undefined)return undefined;node=node[key];}
 return node;
}
function claimMdClaimId(claimMdRecords=[],tracking={}){
 const fromRecords=(claimMdRecords||[]).map(record=>record?.claimmd_id).find(Boolean);
 if(fromRecords)return String(fromRecords);
 const reports=(tracking.reports||[]).slice().reverse();
 const fromReport=reports.map(report=>report?.evidence?.claimmd_id).find(Boolean);
 return fromReport?String(fromReport):'';
}
// One large plain sentence: where the claim stands and how long it has stood there.
function claimCurrentLine(claim={},context={}){
 const now=context.now||new Date(),status=String(claim.status||'draft').toLowerCase();
 const since=at=>timestampOf(at);
 const waiting=from=>{const parsed=since(from),days=parsed?dayGap(parsed,now):null;return parsed?`since ${timelineDate(parsed)}${days===null?'':`, ${days} ${days===1?'day':'days'}`}`:'and we are still waiting';};
 if(status==='void')return 'This claim was voided. Nothing further is expected.';
 if(status==='draft')return 'This claim has not been sent yet.';
 if(status==='ready')return 'Ready to send to Claim.MD.';
 if(status==='rejected'){
  const rejected=[...(context.tracking?.reports||[])].reverse().find(report=>report?.evidence?.status==='R'||report?.evidence?.message?.status==='R');
  const reason=rejected?.evidence?.message?.message||'';
  return `Rejected${rejected?` ${waiting(rejected.received_at)}`:''}. ${reason||'No reason was reported.'}`.trim();
 }
 if(context.era&&String(context.era.row?.status)==='22')return `The payer reversed the payment ${waiting(context.era.remittance?.payment_date)}. Check the account before billing the patient.`;
 if(context.billed)return `The patient was billed ${waiting(context.billedAt)}. Nothing further is expected from the insurance company.`;
 if(context.posted)return `Payment posted ${waiting(context.postedAt)}. The insurance company has paid this claim.`;
 if(status==='adjudicated')return `The insurance company finished processing this claim ${waiting(claim.updated_at)}. Check the payment and what the patient owes.`;
 if(status==='accepted'){
  const accepted=[...(context.tracking?.reports||[])].reverse().find(report=>report?.evidence?.status==='A'&&report?.evidence?.senderid&&report?.evidence?.senderid!=='CLMMD');
  return `Waiting on the insurance company ${waiting(accepted?.received_at||claim.updated_at)}. They have accepted the claim and we have not received a payment.`;
 }
 if(status==='submitted'){
  const sent=[...(context.tracking?.submissions||[])].reverse().find(item=>item?.status==='delivered');
  return `Waiting on the insurance company ${waiting(sent?.created_at||claim.updated_at)}. Claim.MD has the claim and we have not heard back.`;
 }
 return `Current status: ${typeof displayStatus==='function'?displayStatus(status):status}.`;
}
// The whole card. The builder above decides what happened; this only renders it.
function claimTimelineMarkup(timeline){
 if(!timeline||!timeline.steps?.length)return '';
 const rows=timeline.steps.map(step=>`<li class="claim-timeline-step${step.key.startsWith('posted-')||step.key.startsWith('invoice-')?' is-final':''}">
   <div class="claim-timeline-step-head"><b>${esc(step.label)}</b>${step.at?`<time datetime="${esc(step.at)}">${esc(timelineStamp(step.at))}</time>`:'<time class="muted">Date not recorded</time>'}</div>
   ${step.detail?`<p>${esc(step.detail)}</p>`:''}
   ${step.detailExtra?.length?`<p class="muted">${esc(step.detailExtra.join(' · '))}</p>`:''}
   ${step.rows?.length?`<details class="amendment"><summary>${esc(step.rowsSummary||'What was reported')}</summary>${timelineFieldTable(step.rows)}</details>`:''}
   ${step.raw?timelineTechnical([step.raw]):''}
  </li>`).join('');
 const ids=[timeline.identifiers.payerControlNumber?`<span class="claim-timeline-id"><code class="claim-control">${esc(timeline.identifiers.payerControlNumber)}</code><small>Payer claim number</small></span>`:'',
  timeline.identifiers.claimMdClaimId?`<span class="claim-timeline-id"><code class="claim-control">${esc(timeline.identifiers.claimMdClaimId)}</code><small>Claim.MD claim ID</small></span>`:''].join('');
 return `<section class="claim-timeline" aria-label="What happened to this claim"><div class="section-head"><div><p class="eyebrow">WHAT HAPPENED</p><h3>${esc(timeline.current)}</h3>${ids?`<div class="claim-timeline-ids">${ids}</div>`:''}</div></div><ol class="claim-timeline-steps">${rows}</ol><p class="muted">Every step is written in the words the payer or Claim.MD used, with the code that produced it. Nothing here changes the claim or the patient balance.</p></section>`;
}
// Data the claim screen does not already hold, fetched through existing endpoints
// and remembered for this page so opening a claim twice does not call twice.
const claimTimelineCache=new Map();
function claimTimelineCacheKey(claim){return `${claim?.id||''}:${claim?.control_number||''}:${claim?.payer_control_number||''}`;}
async function loadClaimTimelineExtras(claim,options={}){
 const apiCall=options.api||function(){return api.apply(null,arguments);};
 const key=claimTimelineCacheKey(claim);
 if(options.refresh!==true&&claimTimelineCache.has(key))return claimTimelineCache.get(key);
 const extras={claimMdRecords:[],ca277Rows:[],ca277Read:false,era:null,postedAtRead:false,errors:[],invoices:[]};
 const report=message=>{if(!extras.errors.includes(message))extras.errors.push(message);};
 const active=options.connection!==undefined?options.connection:claimMdConnectionState?.active;
 const jobs=[];
 if(active?.id){
  // Claim.MD keeps its notes and website edits in the provider account. Refresh them
  // through the existing endpoints, then read the stored copy. A refresh that fails
  // must not hide what is already stored, so the read runs either way.
  jobs.push((async()=>{
   let refreshed=true;
   for(const kind of ['notes','modifications']){
    try{await apiCall(`/api/v1/billing/claimmd/${active.id}/${kind}/sync`,'POST',{claimmd_id:null});}
    catch{refreshed=false;}
   }
   const data=await apiCall(`/api/v1/billing/claimmd/${active.id}/operations`);
   extras.claimMdRecords=(data.records||[]).filter(record=>['modification','note','archive','uploaded_file'].includes(record.kind)&&claimMdRecordBelongsToClaim(record,claim));
   if(!refreshed)report('Claim.MD notes and changes are shown as of the last successful refresh.');
  })().catch(()=>report('Claim.MD notes and changes could not be loaded.')));
 }
 jobs.push(apiCall(`/api/v1/patients/${claim.patient_id}/billing/accounts/${claim.account_id}/invoices`)
  .then(data=>{extras.invoices=data.items||[];})
  .catch(()=>report('Patient statements could not be loaded.')));
 jobs.push((async()=>{
  const chain=await apiCall(`/api/v1/billing/claims/${claim.id}/era-history`);
  const items=chain.items||[];
  if(!items.length)return;
  // The posting chain says which payment row is the current one for this claim.
  const head=chain.active_head||items[0];
  const detail=await apiCall(`/api/v1/billing/remittances/${head.remittance_id}`);
  const remittance=detail.remittance||{},posting=(detail.postings||[]).find(item=>item.remittance_id===head.remittance_id)||{};
  extras.era={remittance:{...remittance,posted_at:posting.posted_at||head.posted_at||null},row:(remittance.document?.claims||[])[head.row_index]||null,remittanceId:head.remittance_id};
 })().catch(()=>report('The insurance payment for this claim could not be loaded.')));
 // Await each piece on its own. Promise.all would reject as soon as one job failed and
 // throw away the results the other jobs had already stored on extras.
 await Promise.all(jobs.map(job=>job.catch(()=>{})));
 claimTimelineCache.set(key,extras);
 return extras;
}
// The same matching rule the Claim.MD activity panel uses, so the timeline and that
// panel always agree about which provider records belong to this claim.
function claimMdRecordMatchesActivityPanel(record,claim){
 const identities=[claim.id,claim.control_number,claim.payer_control_number].filter(Boolean).map(String);
 const direct=[record.remote_id,record.claimmd_id,record.patient_control_number].filter(Boolean).map(String);
 if(direct.some(value=>identities.includes(value)))return true;
 const content=JSON.stringify(record.content||{});
 return identities.some(value=>content.includes(`"${value}"`));
}
// Claim.MD echoes our patient control number in `claimid`, and its own numeric claim ID
// in `claimmd_id`. The activity panel's rule above compares `claimid` against SunCharts
// identities, so a note carrying only `claimid` would never appear; matching the patient
// control number as well keeps website notes attached to the claim they describe.
function claimMdRecordBelongsToClaim(record,claim){
 if(claimMdRecordMatchesActivityPanel(record,claim))return true;
 // A record naming a different claim's patient control number never joins this claim.
 const controls=[claim.control_number,claim.content?.external_control_number].filter(Boolean).map(String);
 const claimed=[record.patient_control_number,record.content?.pcn].filter(Boolean).map(String);
 if(claimed.some(value=>!controls.includes(value)))return false;
 // Naming our control number attaches the record. Nothing else is inferred from a
 // bare Claim.MD claim ID: the same numeric ID can appear on another tenant's record,
 // and a note that does not name a claim must not be guessed onto someone's chart.
 return claimed.length>0;
}
// 277CA rows for this claim, read through the existing acknowledgment endpoint.
// A row is used only when its claim control matches this claim exactly.
async function loadClaimTimelineCa277Rows(claim,options={}){
 const apiCall=options.api||function(){return api.apply(null,arguments);};
 const controls=[claim.control_number,claim.content?.external_control_number,claim.payer_control_number].filter(Boolean).map(String);
 if(!controls.length)return [];
 const list=await apiCall('/api/v1/billing/277ca');
 const documents=(list.items||[]).filter(document=>document.claim_count>0).slice(0,10);
 const details=await Promise.all(documents.map(document=>apiCall(`/api/v1/billing/277ca/${document.id}`).catch(()=>null)));
 const rows=[];
 for(const detail of details){
  const document=detail?.document;if(!document?.parsed)continue;
  for(const row of document.parsed.claims||[]){
   if(controls.includes(String(row.control||'')))rows.push({...row,received_at:document.created_at,origin:document.origin});
  }
 }
 return rows;
}
// The date a payment was posted is not stored on the remittance itself: a revision
// is written when it posts. Read that date through the existing history endpoint.
async function loadClaimTimelinePostedAt(remittanceId,options={}){
 const apiCall=options.api||function(){return api.apply(null,arguments);};
 const history=await apiCall(`/api/v1/billing/remittances/${remittanceId}/history`);
 const posted=(history.items||[]).find(item=>item.snapshot?.status==='posted');
 return posted?.created_at||null;
}
// Everything the timeline needs that the claim screen has not already loaded. Each
// piece is prepared up front so a provider or ledger failure degrades one section
// instead of discarding the rest.
async function prepareClaimTimeline(claim,detail={},history={},options={}){
 const extras=await loadClaimTimelineExtras(claim,options);
 if(extras.era?.remittance?.status==='posted'&&!extras.era.remittance.posted_at&&!extras.postedAtRead){
  extras.postedAtRead=true;
  try{extras.era.remittance.posted_at=await loadClaimTimelinePostedAt(extras.era.remittanceId,options);}
  catch{ /* the payment date is used instead */ }
 }
 // A claim with no acknowledgment is the normal case, not an error, so a failure here
 // is silent - but the answer is still remembered so a second open asks nothing.
 if(!extras.ca277Read){
  extras.ca277Read=true;
  try{extras.ca277Rows=await loadClaimTimelineCa277Rows(claim,options);}
  catch{extras.ca277Rows=[];}
 }
 const ca277Rows=extras.ca277Rows;
 const timeline=buildClaimTimeline({claim,tracking:detail.tracking||{},history:history.items||history,
  claimMdRecords:extras.claimMdRecords,ca277Rows,
  era:extras.era?{remittance:extras.era.remittance,row:extras.era.row}:null,
  invoices:extras.invoices,now:options.now});
 return {timeline,extras};
}
async function claimTimelineSection(claim,detail={},history={},options={}){
 const {timeline,extras}=await prepareClaimTimeline(claim,detail,history,options);
 return `${claimTimelineMarkup(timeline)}${extras.errors.length?`<p class="muted claim-timeline-gaps">${esc(extras.errors.join(' '))}</p>`:''}`;
}
if(typeof module!=='undefined'&&module.exports)module.exports={buildClaimTimeline,claimCurrentLine,claimTimelineMarkup,claimTimelineSection,claimMdRecordBelongsToClaim,loadClaimTimelineExtras,loadClaimTimelineCa277Rows,loadClaimTimelinePostedAt,prepareClaimTimeline,timelineFieldRows:timelineRecordRows,timelineProviderRows,timelineFieldTable,timelineTechnical,adjustmentLabel,timelineRecordKindLabels,timelineCa277CategoryLabels,timelineEraReasonLabels};
