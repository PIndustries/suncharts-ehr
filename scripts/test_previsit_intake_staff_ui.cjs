// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Staff side of patient intake: sending from the chart, reviewing answers
// against the chart, and the owner's choice of form.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/previsit.js','utf8'),css=fs.readFileSync('web/style.css','utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const escape=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function fixture(role='front_desk'){
 const handlers={},calls=[],notices=[];
 const panel={innerHTML:'',isConnected:true,querySelector:()=>null},summary={textContent:''},tools={innerHTML:'',querySelector(selector){const match=selector.match(/data-intake-loading="(\d+)"/);return match&&this.innerHTML.includes(`data-intake-loading="${match[1]}"`)?{}:null;}};
 const ctx={console,Map,Set,JSON,encodeURIComponent,structuredClone,Promise,FormData:class{},crypto:{randomUUID:()=> 'synthetic-request'},
  me:{tenant_id:'tenant',user_id:'staff',role},selected:'patient-one',workspace:{demographics:{content:{email:'avery.sample@example.test'}}},
  location:{origin:'https://ehr.example.test'},navigator:{clipboard:{writeText:async text=>calls.push(['clipboard',text])}},
  document:{readyState:'loading',addEventListener:(type,listener)=>(handlers[type]??=[]).push(listener),getElementById:()=>null},
  esc:escape,date:value=>String(value??'').slice(0,10),human:value=>String(value).replaceAll('_',' '),notice:message=>notices.push(message),showTool(){},run:work=>ctx.pending=work(),
  $:id=>id==='patient-intake-panel'?panel:id==='patient-intake-summary'?summary:id==='tools'?tools:null,workspaceResourceAllowed:()=>true};
 ctx.api=async(path,method='GET',body,version)=>{calls.push([path,method,body,version]);return ctx.reply(path,method,body);};
 vm.createContext(ctx);vm.runInContext(fs.readFileSync('web/display-format.js','utf8'),ctx);vm.runInContext(source,ctx);
 return {ctx,panel,tools,handlers,calls,notices};
}
const click=(f,attributes,dataset={})=>{const button={dataset,textContent:'',hasAttribute:name=>attributes.includes(name),closest:()=>null};f.handlers.click[0]({target:{closest:()=>button},preventDefault(){},stopImmediatePropagation(){}});return button;};
const row=(extra={})=>({packet_id:'form-open',packet_version:1,status:'sent',default_form:true,expired:false,template_name:'Standard intake form',created_at:'2026-11-10T15:00:00Z',expires_at:'2026-12-10T15:00:00Z',has_response:false,appointment_id:null,...extra});

(async()=>{
 // ---- Chart panel ----
 let f=fixture(),c=f.ctx;
 const items=[row(),row({packet_id:'form-started',status:'in_progress',started_at:'2026-11-11T09:00:00Z',appointment_id:'appointment-1',starts_at:'2026-11-20T15:00:00Z',appointment_title:'New patient visit',appointment_status:'booked'}),row({packet_id:'form-expired',expired:true,expires_at:'2026-10-01T00:00:00Z'}),row({packet_id:'form-filled',packet_version:2,status:'submitted',submitted_at:'2026-11-12T10:00:00Z',has_response:true}),row({packet_id:'form-reviewed',status:'reviewed',submitted_at:'2026-11-01T10:00:00Z',reviewed_at:'2026-11-02T10:00:00Z',has_response:true}),row({packet_id:'form-cancelled',status:'void'}),row({packet_id:'form-journey',default_form:false,workflow_step_key:'contact-form',template_name:'Workflow intake form'})];
 c.reply=(path,method)=>method==='POST'&&path.endsWith('/intake-forms')?{packet_id:'form-new',intake_url:'/intake#token=synthetic-link-secret',secret_shown_once:true,expires_at:'2026-12-13T15:00:00Z',replaced:1,practice_name:'Synthetic Family Clinic'}:method==='POST'?{status:'void'}:{patient_id:'patient-one',items,summary:{total:7,submitted:1,reviewed:1,cancelled:1},next_cursor:null};
 await c.renderPatientIntakePackets();let html=f.panel.innerHTML;
 assert.match(html,/<button type="button" class="primary" data-patient-intake-send>Send intake form<\/button>/);
 // Plain statuses, one per state.
 for(const [key,label] of [['sent','Sent'],['started','Started'],['expired','Expired'],['needs-review','Filled in – needs review'],['reviewed','Reviewed'],['cancelled','Cancelled']])assert.match(html,new RegExp(`data-intake-status="${key}">${label}</span>`));
 assert.match(html,/Sent 2026-11-10 · link works until 2026-12-10/);assert.match(html,/last saved 2026-11-11/);assert.match(html,/filled in 2026-11-12/);assert.match(html,/reviewed 2026-11-02/);
 assert.match(html,/2026-11-20<small>New patient visit · booked<\/small>/);assert.match(html,/No appointment/);
 // Actions only where they make sense.
 const actionsFor=id=>html.split('<tr>').find(part=>part.includes(`data-patient-intake-packet="${id}"`));
 for(const id of ['form-open','form-started','form-expired']){assert.match(actionsFor(id),/Send a new link/);assert.match(actionsFor(id),new RegExp(`data-patient-intake-cancel="${id}">Cancel link`));}
 assert.match(actionsFor('form-started'),/data-patient-intake-resend="appointment-1"/);
 for(const id of ['form-filled','form-reviewed','form-cancelled','form-journey'])assert.doesNotMatch(actionsFor(id),/Send a new link|Cancel link/);
 assert.match(actionsFor('form-filled'),/>Review answers</);assert.match(actionsFor('form-reviewed'),/>View answers</);assert.match(actionsFor('form-open'),/>View form</);
 assert.match(html,/A form that is not tied to an appointment is already waiting\. Sending again cancels that link and makes a new one\. Forms sent for an appointment keep their own link\./);
 // The counts match the list: cancelled forms are listed and counted as cancelled, and left out of the chart overview.
 assert.match(html,/7 forms · 1 filled in and waiting for review · 1 reviewed · 1 cancelled/);assert.equal(c.$('patient-intake-summary').textContent,'6 intake forms · 1 submitted awaiting review');
 assert.doesNotMatch(html,/1 forms|1 intake forms/,'one form is never written as a plural');
 assert.doesNotMatch(html,/intake-link|synthetic-link-secret/,'no link is shown until one is made');

 // A single form reads as one, on both the panel and the chart overview.
 {
  const solo=fixture(),sc=solo.ctx;
  sc.reply=()=>({patient_id:'patient-one',items:[row()],summary:{total:1,submitted:1,reviewed:0,cancelled:0},next_cursor:null});
  await sc.renderPatientIntakePackets();
  assert.match(solo.panel.innerHTML,/>1 form · 1 filled in and waiting for review · 0 reviewed</);
   assert.match(solo.panel.innerHTML,/>1 form · 1 filled in and waiting for review · 0 reviewed</);
  assert.equal(sc.$('patient-intake-summary').textContent,'1 intake form · 1 submitted awaiting review');
  assert.match(solo.panel.innerHTML,/data-patient-intake-packet="form-open"/);
 }

 // Sending shows the link once, with copy, email, expiry and the only-now note.
 click(f,['data-patient-intake-send']);await c.pending;html=f.panel.innerHTML;
 assert.deepEqual(plain(f.calls.find(call=>call[1]==='POST')),['/api/v1/patients/patient-one/intake-forms','POST',{},null]);
 assert.match(html,/class="mapping-notice intake-link" aria-live="polite"/);assert.match(html,/This link is shown only now\./);assert.match(html,/It works until 2026-12-13\./);assert.match(html,/The earlier link no longer works\./);
 assert.match(html,/<button type="button" class="primary" data-patient-intake-copy>Copy link<\/button>/);
 const mailto=html.match(/<a class="button" href="(mailto:[^"]+)">Email the link<\/a>/)[1].replaceAll('&amp;','&');
 assert.ok(mailto.startsWith('mailto:avery.sample@example.test?subject='),'addressed to the email on file');
 const body=decodeURIComponent(mailto.split('&body=')[1]);
 assert.equal(body,'Please fill in your patient forms for Synthetic Family Clinic before your visit:\n\nhttps://ehr.example.test/intake#token=synthetic-link-secret','the email holds only the practice name and the link');
 assert.equal(decodeURIComponent(c.patientIntakeMailto('patient-one','https://ehr.example.test/intake#x','Your practice').split('&body=')[1]),'Please fill in your patient forms before your visit:\n\nhttps://ehr.example.test/intake#x','no placeholder name is ever emailed');
 assert.match(html,/<label class="card-setup-link" hidden>Intake form link<input readonly value="https:\/\/ehr\.example\.test\/intake#token=synthetic-link-secret" data-patient-intake-link><\/label>/);
 assert.match(f.notices.at(-1),/not shown again/);
 // Copy uses the clipboard; when that is not available the link field is revealed instead.
 let button=click(f,['data-patient-intake-copy']);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(f.calls.at(-1),['clipboard','https://ehr.example.test/intake#token=synthetic-link-secret']);assert.equal(button.textContent,'Link copied');
 c.navigator.clipboard=undefined;const field={focused:false,selected:false,focus(){this.focused=true;},select(){this.selected=true;},closest:()=>label},label={hidden:true};
 button=click(f,['data-patient-intake-copy']);button.closest=()=>({querySelector:()=>field});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(label.hidden,false);assert.ok(field.focused&&field.selected);assert.equal(button.textContent,'Copy it from the box below');
 // Without an email on file the message opens with no address, and says so.
 c.workspace.demographics.content.email='';
 click(f,['data-patient-intakes-refresh']);await c.pending;html=f.panel.innerHTML;
 assert.match(html,/href="mailto:\?subject=/);assert.match(html,/No email address is on file for this patient/);
 // A link that is cancelled or filled in afterwards is no longer offered.
 items.unshift(row({packet_id:'form-new',status:'void'}));click(f,['data-patient-intakes-refresh']);await c.pending;assert.doesNotMatch(f.panel.innerHTML,/synthetic-link-secret|intake-link/);
 items.shift();click(f,['data-patient-intake-send']);await c.pending;assert.match(f.panel.innerHTML,/synthetic-link-secret/);
 // Done removes the link from the page; it cannot be shown again.
 click(f,['data-patient-intake-link-done']);html=f.panel.innerHTML;assert.doesNotMatch(html,/synthetic-link-secret|intake-link/);
 // "Send a new link" on a row keeps that row's appointment.
 click(f,['data-patient-intake-resend'],{patientIntakeResend:'appointment-1'});await c.pending;
 assert.deepEqual(plain(f.calls.filter(call=>call[1]==='POST').at(-1)[2]),{appointment_id:'appointment-1'});
 // The chart button names no appointment on purpose: the server attaches the
 // patient's next visit, so the row that comes back shows its date and the
 // patient's form says which visit it is for.
 assert.equal(f.calls.filter(call=>call[1]==='POST').at(-1)[2].appointment_id,'appointment-1');
 c.reply=(path,method)=>method==='POST'&&path.endsWith('/intake-forms')?{packet_id:'form-today',intake_url:'/intake#token=synthetic-today',secret_shown_once:true,expires_at:'2026-11-14T15:00:00Z',replaced:0,practice_name:'Synthetic Family Clinic'}:{patient_id:'patient-one',items:[row({packet_id:'form-today',appointment_id:'appointment-2',starts_at:'2026-11-13T14:30:00Z',appointment_title:'New patient visit',appointment_status:'booked'})],summary:{total:1,submitted:0,reviewed:0,cancelled:0}};
 click(f,['data-patient-intake-send']);await c.pending;
 assert.deepEqual(plain(f.calls.filter(call=>call[1]==='POST').at(-1)[2]),{});
 assert.deepEqual(plain(f.calls.filter(call=>call[1]==='POST').at(-1).slice(0,2)),['/api/v1/patients/patient-one/intake-forms','POST']);
 html=f.panel.innerHTML;
 assert.match(html,/2026-11-13<small>New patient visit · booked<\/small>/,'a patient booked today is not shown as having no appointment');
 assert.doesNotMatch(html,/No appointment/);
 // Only a patient with nothing booked is shown without a visit, in plain words.
 c.reply=()=>({patient_id:'patient-one',items:[row()],summary:{total:1,submitted:0,reviewed:0,cancelled:0}});await c.renderPatientIntakePackets();
 assert.match(f.panel.innerHTML,/<span class="muted">No appointment<\/span>/);
 // Another patient or another signed-in person never sees the link.
 c.selected='patient-two';c.reply=()=>({patient_id:'patient-two',items:[],summary:{total:0,submitted:0,reviewed:0}});await c.renderPatientIntakePackets();assert.doesNotMatch(f.panel.innerHTML,/synthetic-link-secret/);assert.match(f.panel.innerHTML,/No intake forms have been sent to this patient yet\./);
 // Cancelling asks why first, then sends the reason with the form's current version.
 f=fixture();c=f.ctx;c.reply=(path,method)=>method==='POST'?{status:'void',version:2}:{patient_id:'patient-one',items:[row()],summary:{total:1,submitted:0,reviewed:0}};
 await c.renderPatientIntakePackets();assert.doesNotMatch(f.panel.innerHTML,/data-patient-intake-cancel-form/);
 click(f,[],{patientIntakeCancel:'form-open'});html=f.panel.innerHTML;
 assert.match(html,/<form class="intake-cancel-form" data-patient-intake-cancel-form data-packet="form-open" data-version="1">/);assert.match(html,/Why is this link being cancelled\?/);assert.match(html,/The link stops working straight away\./);assert.ok(!f.calls.some(call=>call[1]==='POST'),'opening the question cancels nothing');
 click(f,['data-patient-intake-keep']);assert.doesNotMatch(f.panel.innerHTML,/data-patient-intake-cancel-form/);
 f.handlers.submit[0]({target:{hasAttribute:name=>name==='data-patient-intake-cancel-form',dataset:{packet:'form-open',version:'1'},elements:{reason:{value:' Sent to the wrong person '}}},preventDefault(){},stopImmediatePropagation(){}});await c.pending;
 assert.deepEqual(plain(f.calls.find(call=>call[1]==='POST')),['/api/v1/previsit/packets/form-open/cancel','POST',{reason:'Sent to the wrong person'},1]);assert.match(f.notices.at(-1),/cancelled and no longer works/);
 // A form waiting for an appointment is not replaced by a plain send, so no such note is shown.
 c.reply=()=>({patient_id:'patient-one',items:[row({appointment_id:'appointment-1',starts_at:'2026-11-20T15:00:00Z'})],summary:{total:1,submitted:0,reviewed:0,cancelled:0}});await c.renderPatientIntakePackets();assert.doesNotMatch(f.panel.innerHTML,/already waiting|cancelled<\/p>/);
 // A practice's own form with no appointment: plain status, no made-up date, and the right words when the link is dead.
 const ownForm={packet_id:'form-own',packet_version:1,patient_id:'patient-one',patient_name:'Sample, Avery',status:'sent',starts_at:null,appointment_id:null,expired:false,response:null,template_snapshot:{attestation:'I confirm.',sections:[{label:'Ours',fields:[{key:'q1',label:'Question one',type:'text'}]}]}};
 for(const [extra,status,words] of [[{},'Sent',/The secure form has been issued/],[{status:'in_progress'},'Started',/The secure form has been issued/],[{status:'void'},'Cancelled',/This link was cancelled before the patient sent the form in\./],[{expired:true},'Expired',/This link expired before the patient sent the form in\. Send a new link from the patient’s chart\./]]){
  c.reply=()=>({...ownForm,...extra});await c.openWorkflowIntakePacket('form-own');
  assert.match(f.tools.innerHTML,new RegExp(`<p>${status} · Not tied to an appointment</p>`));assert.match(f.tools.innerHTML,words);assert.doesNotMatch(f.tools.innerHTML,/1970|1969|Invalid Date|undefined|null/);
  if(extra.status==='void'||extra.expired)assert.doesNotMatch(f.tools.innerHTML,/secure form has been issued/);
 }
 c.reply=()=>({...ownForm,starts_at:'2026-11-20T15:00:00Z'});await c.openWorkflowIntakePacket('form-own');assert.match(f.tools.innerHTML,/<p>Sent · 2026-11-20<\/p>/);
 // Staff who cannot send see the list without send or cancel controls.
 f=fixture('nurse');c=f.ctx;c.reply=()=>({patient_id:'patient-one',items:[row()],summary:{total:1,submitted:0,reviewed:0}});await c.renderPatientIntakePackets();
 assert.doesNotMatch(f.panel.innerHTML,/data-patient-intake-send|Send a new link|Cancel link/);assert.match(f.panel.innerHTML,/>View form</);

 // ---- Review: answers by step, beside the chart ----
 f=fixture();c=f.ctx;
 const snapshot={base:'standard',attestation:'I confirm.',sections:[
  {label:'About you',fields:[{key:'first_name',label:'First name',type:'text',required:true,chart_target:'identity.given_name'},{key:'last_name',label:'Last name',type:'text',required:true,chart_target:'identity.family_name'},{key:'date_of_birth',label:'Date of birth',type:'date',required:true,chart_target:'identity.birth_date'},{key:'middle_name',label:'Middle name',type:'text'},{key:'sex',label:'Sex',type:'select',options:['Female','Male','Unknown'],chart_target:'demographics.administrative_gender'},{key:'preferred_name',label:'Preferred name',type:'text',chart_target:'demographics.preferred_name'}]},
  {label:'Contact',fields:[{key:'phone',label:'Mobile or main phone',type:'phone',chart_target:'demographics.phone'},{key:'email',label:'Email',type:'email',chart_target:'demographics.email'},{key:'address_line1',label:'Street address',type:'text',chart_target:'demographics.address.line1'},{key:'city',label:'City',type:'text',chart_target:'demographics.address.city'},{key:'state',label:'State',type:'select',options:['TX','NY'],option_labels:['Texas','New York'],chart_target:'demographics.address.region'}]},
  {label:'More about you',fields:[{key:'race',label:'Race',type:'select',options:['Asian','White','Prefer not to say']}]},
  {label:'Emergency contact',fields:[{key:'emergency_name',label:'Their name',type:'text',chart_target:'demographics.emergency_contact.name'},{key:'emergency_relationship',label:'How are they related to you?',type:'select',options:['Parent','Other'],other_key:'emergency_relationship_other',chart_target:'demographics.emergency_contact.relationship'},{key:'emergency_relationship_other',label:'Please tell us',type:'text',show_if:{key:'emergency_relationship',equals:'Other'}}]},
  {label:'How you will pay',fields:[{key:'payment_method',label:'How do you plan to pay for visits?',type:'select',options:['Insurance','Self-pay']}]},
  {label:'Primary insurance',coverage:'primary',show_if:{key:'payment_method',equals:'Insurance'},fields:[{key:'insurance_company',label:'Insurance company',type:'text',lookup:'insurer',id_key:'insurance_company_id',coverage_field:'company'},{key:'insurance_company_id',label:'Chosen from the list',type:'text',hidden:true,coverage_field:'payer_ref'},{key:'insurance_member_id',label:'Member or policy ID',type:'text',coverage_field:'member_id'},{key:'insurance_group',label:'Group number',type:'text',coverage_field:'group_number'},{key:'insurance_plan',label:'Plan name',type:'text',coverage_field:'plan_name'},{key:'insurance_relationship',label:'Who holds this policy?',type:'select',options:['Self','Spouse','Child','Other'],coverage_field:'relationship'},{key:'insurance_holder_name',label:'Policy holder’s full name',type:'text',show_if:{key:'insurance_relationship',any_of:['Spouse','Child','Other']},coverage_field:'subscriber_name'},{key:'insurance_holder_dob',label:'Policy holder’s date of birth',type:'date',show_if:{key:'insurance_relationship',any_of:['Spouse','Child','Other']},coverage_field:'subscriber_birth_date'}]},
  {label:'Secondary insurance',coverage:'secondary',skippable:true,show_if:{key:'payment_method',equals:'Insurance'},fields:[{key:'insurance2_company',label:'Insurance company',type:'text',coverage_field:'company'}]},
  {label:'Our questions',fields:[{key:'referred_by',label:'Who referred you?',type:'text'}]}]};
 const item={packet_id:'form-filled',packet_version:2,status:'submitted',patient_id:'patient-one',patient_name:'Sample, Avery',mrn:'SYN-1',created_at:'2026-11-10',submitted_at:'2026-11-12',attested_name:'Avery <Sample>',patient_identity:{given_name:'Avery',family_name:'Sampel',birth_date:'1990-04-12'},template_snapshot:snapshot,
  response:{first_name:'avery',last_name:'Sample',date_of_birth:'1990-04-12',middle_name:'Quinn',sex:'Female',preferred_name:'Ave',phone:'555-010-2026',email:'avery.new@example.test',address_line1:'100 Example Street',city:'Sampleville',state:'TX',race:'Asian',emergency_name:'',emergency_relationship:'Other',emergency_relationship_other:'Neighbour',payment_method:'Insurance',insurance_company:'Example <Health> Plan',insurance_member_id:'SYN-12345',insurance_group:'G-77',insurance_plan:'Gold',insurance_relationship:'Spouse',insurance_holder_name:'Jordan Sample',insurance_holder_dob:'1988-02-03',insurance2_company:'',referred_by:'A neighbour'}};
 const demographics={version:4,content:{administrative_gender:'female',phone:'555-010-2026',email:'avery.old@example.test',address:{line1:'9 Old Road',city:null}}};
 const payers={items:[{id:'payer-9',content:{name:'Zeta Mutual',active:true}},{id:'payer-1',content:{name:'Example Health Plan',active:true}},{id:'payer-2',content:{name:'Closed Plan',active:false}},{id:'payer-3',content:{name:'Example Dental',active:true}}]};
 Object.assign(c,{item,demographics,payers});
 html=c.standardIntakeReviewView(item,demographics,payers);
 // Every answered step is listed, in order, including the practice's own questions.
 assert.deepEqual([...html.matchAll(/<section class="billing-section intake-review-step"><h3>([^<]+)<\/h3>/g)].map(match=>match[1]),['About you','Contact','More about you','Emergency contact','How you will pay','Primary insurance','Secondary insurance','Our questions']);
 assert.match(html,/<h3>Secondary insurance<\/h3><p class="muted">The patient skipped this step\.<\/p>/);
 assert.match(html,/Patient’s answer<\/th><th>On the chart now/);assert.match(html,/Avery &lt;Sample&gt;/);assert.doesNotMatch(html,/<Sample>|<Health>/);
 const rowFor=label=>html.split('<tr>').find(part=>part.startsWith(`<td>${label}</td>`));
 // Name and date of birth: compared, never offered for copying.
 assert.match(rowFor('First name'),/Matches the chart/);assert.match(rowFor('Last name'),/Different from the chart\. Check with the patient/);assert.match(rowFor('Date of birth'),/Matches the chart/);
 for(const label of ['First name','Last name','Date of birth'])assert.doesNotMatch(rowFor(label),/type="checkbox"/);
 // Ticked only where the chart has nothing.
 assert.match(rowFor('Preferred name'),/name="field" value="preferred_name" checked> Add to the chart/);assert.match(rowFor('Preferred name'),/Nothing on the chart/);
 assert.match(rowFor('City'),/value="city" checked> Add to the chart/);assert.match(rowFor('State'),/<strong>Texas<\/strong>/);assert.match(rowFor('State'),/value="state" checked/);
 // A different value on the chart is left unticked; staff may tick to replace it.
 assert.match(rowFor('Email'),/value="email" > Replace what is on the chart/);assert.doesNotMatch(rowFor('Email'),/checked/);assert.match(rowFor('Email'),/avery\.old@example\.test/);assert.match(rowFor('Email'),/Leave unticked to keep the chart as it is/);
 assert.match(rowFor('Street address'),/value="address_line1" > Replace what is on the chart/);assert.doesNotMatch(rowFor('Street address'),/checked/);
 // The same value needs no box; no answer offers no box.
 assert.match(rowFor('Mobile or main phone'),/Already on the chart/);assert.doesNotMatch(rowFor('Mobile or main phone'),/type="checkbox"/);
 assert.match(rowFor('Sex'),/Already on the chart/,'Female on the form is female on the chart');
 assert.match(rowFor('Their name'),/Not answered/);assert.doesNotMatch(rowFor('Their name'),/type="checkbox"/);
 // Everything else stays on the form and is shown plainly.
 assert.match(rowFor('Middle name'),/Stays on this form/);assert.match(html,/<dt>Race<\/dt><dd>Asian<\/dd>/);assert.match(html,/<dt>Who referred you\?<\/dt><dd>A neighbour<\/dd>/);
 // "Other" is shown, and copied, as what the patient wrote.
 assert.match(rowFor('How are they related to you?'),/<strong>Other: Neighbour<\/strong>/);assert.match(rowFor('How are they related to you?'),/value="emergency_relationship" checked/);
 assert.doesNotMatch(html,/Chosen from the list/,'the reference a patient picked is used, never listed as an answer');
 assert.equal((html.match(/type="checkbox" form="intake-standard-review" name="field"/g)||[]).length,6);assert.equal((html.match(/name="field" value="[a-z_0-9]+" checked/g)||[]).length,4);
 // One button reviews and copies the ticked answers.
 assert.match(html,/<form id="intake-standard-review" class="billing-section" data-packet="form-filled" data-version="2" data-status="submitted" data-demographics-version="4">/);assert.match(html,/Mark reviewed and add ticked answers to the chart/);assert.match(html,/Anything you leave unticked stays on this form and the chart is not changed\./);
 // Insurance: a pre-filled form per filled-in insurance step; nothing is saved by opening it.
 assert.match(html,/<summary>Add as primary insurance<\/summary><form id="intake-standard-coverage" data-patient="patient-one" data-packet="form-filled"/);assert.doesNotMatch(html,/Add as secondary insurance/,'a blank second insurance offers nothing');
 assert.match(html,/The patient typed <strong>Example &lt;Health&gt; Plan<\/strong>/);assert.match(html,/Nothing is saved until you press Save\./);
 // A typed name: the practice's companies are listed closest first, none chosen for staff.
 assert.deepEqual([...html.matchAll(/<option value="(payer-\d)" >/g)].map(match=>match[1]),['payer-1','payer-3','payer-9']);assert.doesNotMatch(html,/Closed Plan/);assert.doesNotMatch(html,/<option value="payer-\d" selected/);assert.match(html,/the closest names are first/);
 // A short list needs no search box, so its label is hidden with it; a long list shows both.
 assert.match(html,/<label hidden>Find in your insurance companies<input type="search" data-intake-payer-filter/);
 const many={items:Array.from({length:9},(_,index)=>({id:`payer-m${index}`,content:{name:`Synthetic Plan ${index}`,active:true}}))};
 assert.match(c.standardIntakeReviewView(item,demographics,many),/<label >Find in your insurance companies<input type="search" data-intake-payer-filter/);
 // "Coverage starts" is filled with today so the form can be saved, and says it can be changed.
 const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
 assert.match(html,new RegExp(`Coverage starts <small>Set to today\\. Change it if the coverage started earlier\\.</small><input name="effective_date" type="date" required value="${today}">`));
 // Staff are never sent to another screen to finish.
 assert.doesNotMatch(html+source,/under Billing &amp; insurance first|then come back to this form/);
 // Front desk cannot create insurance companies (owner-only); the owner adds one in place.
 assert.match(html,/Only the practice owner can add a new insurance company/);assert.doesNotMatch(html,/data-intake-add-payer>/);
 c.me={...c.me,role:'owner'};let asOwner=c.standardIntakeReviewView(item,demographics,payers);
 assert.match(asOwner,/data-intake-payer-name maxlength="200" value="Example &lt;Health&gt; Plan"/);assert.match(asOwner,/<button type="button" data-intake-add-payer>Add “Example &lt;Health&gt; Plan” as a new insurance company<\/button>/);
 // A company the patient picked from the practice's list is already selected.
 asOwner=c.standardIntakeReviewView({...item,response:{...item.response,insurance_company:'Example Dental',insurance_company_id:'payer-3'}},demographics,payers);
 assert.match(asOwner,/The patient chose <strong>Example Dental<\/strong>\. It is selected below/);assert.match(asOwner,/<option value="payer-3" selected>Example Dental<\/option>/);assert.doesNotMatch(asOwner,/data-intake-add-payer/);
 // So is one typed exactly as the practice names it.
 asOwner=c.standardIntakeReviewView({...item,response:{...item.response,insurance_company:'zeta mutual',insurance_company_id:''}},demographics,payers);assert.match(asOwner,/<option value="payer-9" selected>/);
 // A company picked from the clearinghouse list brings its payer ID to the add box.
 asOwner=c.standardIntakeReviewView({...item,response:{...item.response,insurance_company:'Example Mutual',insurance_company_id:'claimmd:EX123'}},demographics,payers);
 assert.match(asOwner,/data-intake-payer-code maxlength="100" value="EX123"/);assert.match(asOwner,/The patient chose <strong>Example Mutual<\/strong>/);
 // No companies at all: the form still opens and the owner adds the first one in place.
 asOwner=c.standardIntakeReviewView(item,demographics,{items:[]});assert.match(asOwner,/Your practice has no insurance companies yet\./);assert.match(asOwner,/data-intake-add-payer>/);assert.match(asOwner,/id="intake-standard-coverage"/);
 // Adding in place: one request, the new company is selected, and the form is not redrawn.
 const added=[],select={value:'',insertAdjacentHTML:(_where,markup)=>added.push(markup)},box={hidden:false,querySelector:selector=>({value:selector.includes('name')?' Example Mutual ':'EX123'})},payerForm={isConnected:true,elements:{payer_id:select}};
 c.reply=()=>({id:'payer-new',content:{name:'Example Mutual'}});f.calls.length=0;
 f.handlers.click.at(-1)({target:{closest:selector=>selector==='[data-intake-add-payer]'?{disabled:false,closest:inner=>inner==='form'?payerForm:box}:null},preventDefault(){},stopImmediatePropagation(){}});await c.pending;
 assert.deepEqual(plain(f.calls),[['/api/v1/billing/payers','POST',{request_id:'synthetic-request',source_history_id:null,content:{name:'Example Mutual',payer_code:'EX123',phone:'',address:'',active:true},reason:'Added while reviewing a patient intake form'},null]]);
 assert.equal(select.value,'payer-new');assert.match(added[0],/<option value="payer-new">Example Mutual<\/option>/);assert.equal(box.hidden,true);assert.match(f.notices.at(-1),/was added and is selected/);
 c.me={...c.me,role:'front_desk'};f.calls.length=0;
 for(const [name,value] of [['member_id','SYN-12345'],['group_number','G-77'],['plan_name','Gold'],['subscriber_name','Jordan Sample'],['subscriber_birth_date','1988-02-03']])assert.match(html,new RegExp(`name="${name}"[^>]*value="${value}"`));
 assert.match(html,/<option value="spouse" selected>spouse<\/option>/);assert.match(html,/<input type="hidden" name="priority" value="primary">/);
 // The patient as policy holder: their own name and date of birth are filled in.
 let own=c.standardIntakeReviewView({...item,response:{...item.response,first_name:'Avery',insurance_relationship:'Self',insurance_holder_name:undefined,insurance_holder_dob:undefined}},demographics,payers);
 assert.match(own,/name="subscriber_name"[^>]*value="Avery Sample"/);assert.match(own,/name="subscriber_birth_date"[^>]*value="1990-04-12"/);assert.match(own,/<option value="self" selected>/);assert.doesNotMatch(own,/Policy holder’s full name<\/td>/,'questions the patient was not shown are not listed');
 // Self-pay answers show no insurance steps at all.
 own=c.standardIntakeReviewView({...item,response:{...item.response,payment_method:'Self-pay'}},demographics,payers);assert.doesNotMatch(own,/Primary insurance|intake-standard-coverage/);
 // Already reviewed: the button only copies.
 const reviewed=c.standardIntakeReviewView({...item,status:'reviewed',packet_version:3},demographics,payers);assert.match(reviewed,/data-status="reviewed"/);assert.match(reviewed,/>Add ticked answers to the chart<\/button>/);assert.doesNotMatch(reviewed,/Mark reviewed/);
 // Not sent in, cancelled or expired: no answers, a plain explanation.
 assert.match(c.standardIntakeReviewView({...item,status:'sent',response:null},null,null),/has not sent this form in yet/);assert.match(c.standardIntakeReviewView({...item,status:'void',response:null},null,null),/This link was cancelled/);assert.match(c.standardIntakeReviewView({...item,status:'sent',expired:true,response:null},null,null),/This link expired/);
 // Staff who cannot review see the answers and the comparison, but no boxes or buttons.
 c.me={...c.me,role:'nurse'};const readOnly=c.standardIntakeReviewView(item,demographics,payers);assert.doesNotMatch(readOnly,/type="checkbox"|intake-standard-review|intake-standard-coverage/);assert.match(readOnly,/Different from the chart/);c.me={...c.me,role:'front_desk'};

 // Opening a standard form loads the chart's contact details beside it; other forms keep their own screen.
 c.reply=path=>path.endsWith('/demographics')?demographics:path.endsWith('/payers')?payers:item;
 await c.openWorkflowIntakePacket('form-filled');
 assert.deepEqual(f.calls.map(call=>call[0]),['/api/v1/previsit/packets/form-filled','/api/v1/patients/patient-one/demographics','/api/v1/billing/payers']);assert.match(f.tools.innerHTML,/id="intake-standard-review"/);
 // Review then copy: two requests, in order, with the reviewed version and only the ticked questions.
 f.calls.length=0;c.reply=(path,method)=>path.endsWith('/review')?{status:'reviewed',version:3}:path.endsWith('/demographics')&&method==='POST'?{version:5}:path.endsWith('/demographics')?demographics:path.endsWith('/payers')?payers:{...item,status:'reviewed',packet_version:3};
 const form={id:'intake-standard-review',isConnected:true,dataset:{packet:'form-filled',version:'2',status:'submitted',demographicsVersion:'4'},elements:Object.assign([{name:'field',value:'preferred_name',checked:true},{name:'field',value:'email',checked:false},{name:'field',value:'city',checked:true},{name:'reason',value:'x'}],{reason:{value:'Checked at the desk'}}),querySelector:()=>({disabled:false})};
 f.handlers.submit.at(-1)({target:form,preventDefault(){},stopImmediatePropagation(){}});await c.pending;
 assert.deepEqual(plain(f.calls.slice(0,2)),[['/api/v1/previsit/packets/form-filled/review','POST',{},2],['/api/v1/previsit/packets/form-filled/demographics','POST',{fields:['preferred_name','city'],demographics_version:4,reason:'Checked at the desk'},3]]);assert.match(f.notices.at(-1),/Reviewed\. 2 answers were added to the chart\./);
 // Nothing ticked: reviewed only, and the chart is not touched.
 f.calls.length=0;await c.openWorkflowIntakePacket('form-filled');f.calls.length=0;
 form.elements=Object.assign([{name:'field',value:'email',checked:false}],{reason:{value:'Checked'}});f.handlers.submit.at(-1)({target:form,preventDefault(){},stopImmediatePropagation(){}});await c.pending;
 assert.deepEqual(plain(f.calls[0]),['/api/v1/previsit/packets/form-filled/review','POST',{},2]);assert.ok(!f.calls.some(call=>call[1]==='POST'&&call[0].endsWith('/demographics')));assert.match(f.notices.at(-1),/The chart was not changed\./);

 // ---- Owner settings: the standard form by default, the practice's own questions after it ----
 const standard={attestation:'Standard confirmation.',sections:[{label:'About you',fields:[{key:'first_name',label:'First name',type:'text',required:true}]},{label:'How you will pay',fields:[{key:'payment_method',label:'How do you plan to pay for visits?',type:'select',required:true,options:['Insurance','Self-pay'],option_labels:['With insurance','I will pay myself']}]},{label:'Secondary insurance',skippable:true,show_if:{key:'payment_method',equals:'Insurance'},fields:[{key:'insurance2_company',label:'Insurance company',type:'text',required:true}]}]};
 let builder=c.intakeTemplateBuilder(null,'standard',standard);
 assert.match(builder,/name="intake_mode" value="standard" checked><span><b>Use the standard intake form<\/b>/);assert.match(builder,/name="intake_mode" value="own" ><span><b>Use only our own form<\/b>/);
 assert.match(builder,/<h4 data-intake-own-title>Add your own questions<\/h4>/);assert.match(builder,/becomes an extra step after the standard steps/);
 assert.doesNotMatch(builder,/data-intake-section /,'nothing of the practice’s own until they add it');
 assert.match(builder,/<details class="billing-section intake-standard-preview" data-intake-standard-only >/);assert.match(builder,/See the 3 standard steps/);assert.match(builder,/<b>Secondary insurance<\/b> <small>Only when “How do you plan to pay for visits\?” is “With insurance”<\/small> <small>Patients can skip this step<\/small>/);assert.match(builder,/never ask for a Social Security or driver’s licence number/);assert.doesNotMatch(builder.match(/intake-standard-preview[\s\S]*?<\/details>/)[0],/<input|<select|<textarea|<button/,'the preview cannot be edited');
 assert.match(builder,/Standard confirmation\./);
 // A practice with its own saved form keeps it until the owner switches.
 builder=c.intakeTemplateBuilder({attestation:'Ours.',sections:[{label:'Our section',intro:'Kept',fields:[{key:'q1',label:'Question one',type:'number',required:true,help:'A hint',show_if:{key:'q0',equals:'Yes'},max_length:5}]}]},'own',standard);
 assert.match(builder,/name="intake_mode" value="own" checked>/);assert.match(builder,/data-intake-standard-only hidden>/);assert.match(builder,/<h4 data-intake-own-title>Your questions<\/h4>/);
 assert.match(builder,/<option value="number" selected>number<\/option>/,'number questions can be built');assert.match(builder,/data-intake-field-help maxlength="300" value="A hint"/);
 assert.match(builder,/data-intake-field-extra="\{&quot;show_if&quot;:\{&quot;key&quot;:&quot;q0&quot;,&quot;equals&quot;:&quot;Yes&quot;\},&quot;max_length&quot;:5\}"/);assert.match(builder,/data-intake-section-extra="\{&quot;intro&quot;:&quot;Kept&quot;\}"/);
 // Reading the builder back: mode, kept settings, and clear messages for clashes.
 const fakeField=(values,extra='{}')=>({dataset:{intakeFieldExtra:extra},querySelector:selector=>{const name=selector.match(/data-intake-(?:field-)?([a-z-]+)\]/)[1];return name in values?(typeof values[name]==='boolean'?{checked:values[name]}:{value:values[name]}):null;}});
 const fakeForm=(mode,sections)=>({querySelector:selector=>selector.includes('intake_mode')?{value:mode}:{value:' We confirm. '},querySelectorAll:()=>sections.map(section=>({dataset:{intakeSectionExtra:section.extra||'{}'},querySelector:()=>({value:section.label}),querySelectorAll:()=>section.fields}))});
 c.previsitStandard=standard;vm.runInContext('previsitStandard=this.previsitStandard',c);
 assert.deepEqual(JSON.parse(JSON.stringify(c.intakeTemplateSchema(fakeForm('standard',[])))),{base:'standard',attestation:'We confirm.',sections:[]});
 const kept=JSON.parse(JSON.stringify(c.intakeTemplateSchema(fakeForm('standard',[{label:'Ours',extra:'{"skippable":true,"skip_label":"Not now"}',fields:[fakeField({label:'Pick one',key:'pick',type:'select',required:true,'chart-target':'',help:' Choose ',options:'A\nB'},'{"option_labels":["Alpha","Beta"],"show_if":{"key":"payment_method","equals":"Insurance"}}')]}]))));
 assert.deepEqual(kept,{base:'standard',attestation:'We confirm.',sections:[{label:'Ours',skippable:true,skip_label:'Not now',fields:[{key:'pick',label:'Pick one',type:'select',required:true,help:'Choose',options:['A','B'],show_if:{key:'payment_method',equals:'Insurance'},option_labels:['Alpha','Beta']}]}]});
 assert.throws(()=>c.intakeTemplateSchema(fakeForm('standard',[{label:'Ours',fields:[fakeField({label:'Your first name',key:'first_name',type:'text',required:false,'chart-target':''})]}])),/“Your first name” uses the short name “first_name”, which the standard step “About you” already uses/);
 assert.deepEqual(Object.keys(c.intakeTemplateSchema(fakeForm('own',[{label:'Ours',fields:[fakeField({label:'Your first name',key:'first_name',type:'text',required:false,'chart-target':''})]}]))),['attestation','sections'],'a practice’s own form may use any names and records no mode');
 assert.throws(()=>c.intakeTemplateSchema(fakeForm('own',[])),/choose the standard intake form/);assert.throws(()=>c.intakeTemplateSchema(fakeForm('standard',[{label:'Empty',fields:[]}])),/remove the empty section/);
 // Settings screen: nothing saved shows the standard form selected; saving never sends the radio as its own value.
 f=fixture('owner');c=f.ctx;c.reply=path=>path.endsWith('/settings')?{profile:null,template:null,intake_mode:'standard',standard}:path.endsWith('/providers')?{items:[{id:'provider-a',label:'Synthetic clinician'}]}:{items:[]};
 await c.showPrevisit();assert.match(f.tools.innerHTML,/Standard intake form · nothing saved yet/);assert.match(f.tools.innerHTML,/name="intake_mode" value="standard" checked/);assert.match(f.tools.innerHTML,/>Save intake form<\/button>/);
 assert.match(source,/delete data\.intake_mode;data\.schema=intakeTemplateSchema\(form\)/);

 // Looks right in dark mode: theme variables only, no fixed light colours.
 const themed=css.slice(css.indexOf('/* Patient intake forms: chart panel'));
 assert.ok(themed.length>200);assert.doesNotMatch(themed,/#[0-9a-fA-F]{3,8}\b|rgb\(|:\s*white\b/);assert.match(themed,/\.intake-cancel-form\{[^}]*background:var\(--surface\)/);assert.match(themed,/\.intake-status\{[^}]*color:var\(--ink\)/);
 // The owner's question editor uses the theme too (it used to stay white in dark mode).
 const builderCss=css.split('\n').find(line=>line.startsWith('.intake-template-builder{'));
 assert.match(builderCss,/\.intake-field-builder\{background:var\(--surface-soft\);color:var\(--ink\);border:1px solid var\(--line\)/);assert.doesNotMatch(builderCss,/#[0-9a-fA-F]{3,8}\b|--panel-subtle/);
 // Staff copy stays in plain words.
 const copy=[c.intakeTemplateBuilder(null,'standard',standard),fixture().ctx.standardIntakeReviewView(item,demographics,payers)].join('').replace(/<[^>]+>/g,' ');
 for(const word of ['packet','token','schema','payload','snapshot','idempotent'])assert.doesNotMatch(copy,new RegExp(`\\b${word}`,'i'),`staff are not shown “${word}”`);
 console.log('PASS intake staff UI: send, copy, email and cancel from the chart; plain statuses; answers by step beside the chart with safe ticks; insurance hand-off; standard form choice and preview');
})().catch(error=>{console.error(error);process.exitCode=1;});
