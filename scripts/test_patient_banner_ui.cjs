// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The patient banner: every state of every item, escaping, the More menu, refresh after
// saves, and the stylesheet rules that keep it themed and compact. Synthetic data only.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const read=file=>fs.readFileSync(file,'utf8');
const banner=read('web/patient-banner.js'),format=read('web/display-format.js'),eligibility=read('web/claimmd-eligibility.js'),app=read('web/app.js'),css=read('web/patient-banner.css'),index=read('web/index.html'),lib=read('src/lib.rs');
const NOW=new Date(2026,10,13,10,0,0),iso=(day,hour=9,minute=0)=>new Date(2026,10,day,hour,minute,0).toISOString();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const allergy=(title,extra={})=>({kind:'allergy',content:{title,status:'active',verification:'confirmed',detail:{kind:'allergy',reaction:'Hives',severity:'severe'},...extra}});
const coverage=(id,priority,payer,extra={})=>({id,content:{payer_id:payer,priority,status:'active',member_id:'SYN-'+id,plan_name:'',effective_date:'2026-01-01',end_date:null,copay_cents:null,...extra}});
const check=(coverageId,status,code,extra={})=>({id:'check-'+coverageId,coverage_id:coverageId,status,created_at:'2026-11-13T15:00:00Z',completed_at:status==='pending'?null:'2026-11-13T15:00:05Z',request_snapshot:{request:{insured_given_name:'Maria',insured_family_name:'Synthetic'}},response_snapshot:status==='completed'?{elig:[{ins_name_f:'MARIA',ins_name_l:'SYNTHETIC',benefit:code?[{benefit_code:'30',benefit_coverage_code:code}]:[]}]}:status==='failed'?{failure:{kind:'transport_unavailable'}}:null,...extra});
function fixture(options={}){
 const hosts={},timers=[],calls=[],listeners={};
 const host={innerHTML:'',style:{setProperty(name,value){host.style[name]=value;}},contains:()=>false,querySelector:()=>null,querySelectorAll:()=>[]};
 hosts['patient-banner']=host;
 const c={console,Date,Intl,Map,Set,Number,String,JSON,Math,Promise,Array,Object,RegExp,Error,esc,
  selected:'p1',me:{user_id:'owner1',tenant_id:'t1',role:'owner'},activeVisit:undefined,billingPayers:[{id:'payer-a',content:{name:'Synthetic Health Plan'}},{id:'payer-b',content:{name:'Synthetic Silver HMO'}}],
  workspace:{patient:{id:'p1',mrn:'SYN-1001',given_name:'Maria',family_name:'Synthetic',birth_date:'1990-01-01',archived:false},appointments:[],visits:[],clinical:{items:[],reviews:[]},billing:{coverages:[]},demographics:{content:{}}},
  $:id=>hosts[id]||null,date:String,human:String,billingWrite:()=>true,billingCan:()=>true,
  document:{addEventListener:(name,fn)=>(listeners[name]??=[]).push(fn),visibilityState:'visible',activeElement:null,querySelector:()=>null},
  setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>{if(timers[id-1])timers[id-1].cancelled=true;},
  api:async(path,method='GET')=>{calls.push([path,method]);if(typeof c.answer==='function')return c.answer(path);return c.answer;},
  answer:{patient_id:'p1',flags:{archived:false,intake_to_review:0,intake_sent:0,portal_status:null,unsigned_notes:0},next_appointment:null,last_visit:null,revision:'r1',billing:{patient_due_cents:0,open_invoice_count:0,invoice_review_count:0,card_on_file:false},eligibility:[]},
  chartAreaEnabled:()=>true,canSchedule:()=>true,canStartEncounterFlow:()=>true,isRoomingStaff:()=>false,
  supportHelpButton:(subject,attributes='')=>`<button type="button" class="quiet support-help" data-support-help ${attributes}>Get help with this ${subject}</button>`,
  patientLifecycleStates:new Map([['p1',{patient_id:'p1',archived:false,can_manage:true,version:1}]])};
 vm.createContext(c);vm.runInContext(format+'\n'+eligibility+'\n'+banner,c);
 Object.assign(c,options);
 const run=code=>vm.runInContext(code,c);
 return {c,host,timers,calls,listeners,run,
  // Opens the chart: paints from memory, reads the banner facts, paints again.
  async open(){await run('patientBannerChartRendered()');return host.innerHTML;},
  markup(){return run('patientBannerMarkup(now)');},
  row(html=host.innerHTML){return html.slice(html.indexOf('patient-banner-bottom'));},
  async fire(){for(const timer of timers.splice(0))if(!timer.cancelled)timer.fn();await run('patientBanner.request');await new Promise(resolve=>setImmediate(resolve));}};
}
const itemOf=(html,key)=>{const at=html.indexOf(`data-banner-item="${key}"`);if(at<0)return '';const start=html.lastIndexOf('<',at),tag=html.slice(start+1,start+7).startsWith('button')?'</button>':'</span>';return html.slice(start,html.indexOf(tag,at)+tag.length);};
const flagsOf=html=>[...html.slice(0,html.indexOf('patient-banner-actions')).matchAll(/data-banner-flag="([a-z-]+)"[^>]*>([^<]+)</g)].map(match=>match[2]);

(async()=>{
 // ---- Who ------------------------------------------------------------------------------
 let f=fixture({now:NOW});f.c.workspace.demographics.content={administrative_gender:'female',preferred_name:'Mia'};
 let html=await f.open();
 assert.match(html,/<h2 class="patient-banner-name" title="Synthetic, Maria">Synthetic, Maria<\/h2>/);
 assert.match(html,/>36 · F</);assert.match(html,/title="Date of birth">Jan 1, 1990</);assert.match(html,/MRN SYN-1001/);assert.match(html,/goes by Mia/);
 assert.match(html,/<span class="avatar" aria-hidden="true">MS<\/span>/);
 for(const [gender,shown] of [['male','36 · M'],['other','36 · Other'],['unknown','36'],[undefined,'36']]){f.c.workspace.demographics.content={administrative_gender:gender};const who=f.markup();assert.ok(who.includes(`>${shown}<`),`${gender} shows ${shown}`);assert.doesNotMatch(who,/goes by/);}
 f.c.now=new Date(2026,0,1,0,0,0);assert.match(f.markup(),/>36</,'the birthday itself counts');f.c.now=new Date(2025,11,31,23,0,0);assert.match(f.markup(),/>35</);f.c.now=NOW;
 console.log('PASS who: name, age and sex only when recorded, plain date of birth, MRN and the name the patient goes by');

 // ---- Allergies ------------------------------------------------------------------------
 f=fixture({now:NOW});f.c.workspace.clinical={items:[allergy('Penicillin'),allergy('Latex',{verification:'unconfirmed'}),allergy('Sulfa'),allergy('Peanuts'),allergy('Old',{status:'inactive'}),allergy('Wrong',{verification:'refuted'}),allergy('Mistake',{verification:'entered_in_error'}),{kind:'problem',content:{title:'Asthma',status:'active',verification:'confirmed'}}],reviews:[{kind:'allergy',review_state:'needs_review'}]};
 html=await f.open();let item=itemOf(html,'allergies');
 assert.match(item,/class="patient-banner-item patient-banner-allergies is-recorded"/);assert.match(item,/Allergies: Penicillin, Latex<\/span><span class="patient-banner-count">\+2</);assert.match(item,/data-clinical-focus="allergy"/);
 assert.match(item,/title="Allergies: Penicillin — Hives, severe; Latex — Hives, severe — Unconfirmed; Sulfa — Hives, severe; Peanuts — Hives, severe\. Open the allergy list\."/);assert.doesNotMatch(item,/Old|Wrong|Mistake|Asthma/);
 assert.match(html,/<dt>Allergies<\/dt><dd>Penicillin, Latex, Sulfa, Peanuts<\/dd>/,'the full list is one click away in Details');
 f.c.workspace.clinical={items:[allergy('Penicillin')],reviews:[]};assert.match(itemOf(f.markup(),'allergies'),/Allergies: Penicillin<\/span><\/button>/);
 f.c.workspace.clinical={items:[],reviews:[{kind:'allergy',review_state:'no_known'}]};item=itemOf(f.markup(),'allergies');assert.match(item,/is-none/);assert.match(item,/No known allergies/);
 // Only a recorded "no known allergies" may say so. Every other empty list says what is actually known.
 for(const [reviews,state,text] of [[[{kind:'allergy',review_state:'reviewed'}],'is-empty','No allergies recorded'],[[{kind:'allergy',review_state:'unknown'}],'is-unreviewed','Allergies not reviewed'],[[{kind:'allergy',review_state:'needs_review'}],'is-unreviewed','Allergies not reviewed'],[[],'is-unreviewed','Allergies not reviewed'],[[{kind:'medication',review_state:'no_known'}],'is-unreviewed','Allergies not reviewed']]){
  f.c.workspace.clinical={items:[allergy('Stopped',{status:'inactive'})],reviews};item=itemOf(f.markup(),'allergies');assert.ok(item.includes(state)&&item.includes(text),`${JSON.stringify(reviews)} shows ${text}`);assert.doesNotMatch(item,/No known allergies/);assert.match(item,/data-clinical-focus="allergy"/,'the prompt goes to the place to review');
 }
 console.log('PASS allergies: recorded with +N and full list on hover, no known allergies only when recorded, and an amber prompt when never reviewed');

 // ---- Insurance ------------------------------------------------------------------------
 f=fixture({now:NOW});f.c.workspace.billing.coverages=[coverage('cov-b','secondary','payer-b'),coverage('cov-a','primary','payer-a',{plan_name:'Gold PPO',copay_cents:1500}),coverage('cov-old','primary','payer-b',{end_date:'2026-06-30'}),coverage('cov-off','primary','payer-b',{status:'inactive'}),coverage('cov-later','primary','payer-b',{effective_date:'2027-01-01'})];
 f.c.answer.eligibility=[check('cov-a','completed','1'),check('cov-b','completed','6')];
 html=await f.open();item=itemOf(html,'insurance');
 assert.match(item,/<b>Synthetic Health Plan<\/b> <span class="patient-banner-plan patient-banner-wide">Gold PPO<\/span>/);assert.match(item,/data-chart-section="insurance"/);
 assert.match(item,/<span class="eligibility-pill patient-banner-pill active" data-eligibility-state="active"><span aria-hidden="true">✓<\/span> Active<\/span>/,'the pill has words, not only a colour');
 assert.match(item,/Active as of Nov 13, 2026/);assert.match(item,/>\$15 copay</);assert.match(item,/>\+1 more</);assert.match(item,/1 more coverage: Synthetic Silver HMO/);
 assert.doesNotMatch(item,/<button[^>]*data-claimmd-eligibility/,'read-only: the banner never starts a check');
 const pill=(checks,extra={})=>{f.c.answer={...f.c.answer,eligibility:checks,...extra};f.run('patientBanner.data=answer');return itemOf(f.markup(),'insurance');};
 item=pill([check('cov-a','completed','6')]);assert.match(item,/eligibility-pill patient-banner-pill inactive" data-eligibility-state="inactive"><span aria-hidden="true">✕<\/span> Not active</);
 item=pill([check('cov-b','completed','1')]);assert.match(item,/data-eligibility-state="none"><span aria-hidden="true">–<\/span> Not checked</,'another coverage\'s answer is never borrowed');assert.doesNotMatch(item,/patient-banner-pill (active|inactive|unknown)"/);
 item=pill([]);assert.match(item,/Not checked/);
 item=pill([check('cov-a','failed')]);assert.match(item,/patient-banner-pill unknown" data-eligibility-state="unknown"><span aria-hidden="true">!<\/span> Could not confirm</);
 item=pill([check('cov-a','completed',null)]);assert.match(item,/data-eligibility-state="unknown"><span aria-hidden="true">!<\/span> Could not confirm</);
 item=pill([check('cov-a','pending')]);assert.match(item,/data-eligibility-state="none"><span aria-hidden="true">…<\/span> Waiting for the insurer</);
 // The words come from the eligibility card's own summary, so the two can never disagree.
 for(const sample of [check('cov-a','completed','1'),check('cov-a','completed','6'),check('cov-a','completed',null),check('cov-a','failed'),check('cov-a','pending')]){f.c.sample=sample;assert.ok(pill([sample]).includes(' '+f.run('claimmdStatusLabel(sample)')+'</span>'));}
 const withoutClaims={...f.c.answer};delete withoutClaims.eligibility;f.c.answer=withoutClaims;f.run('patientBanner.data=answer');item=itemOf(f.markup(),'insurance');assert.match(item,/Synthetic Health Plan/);assert.doesNotMatch(item,/eligibility-pill/,'no pill at all when the answer is not shared with this role');
 f.c.workspace.billing.coverages=[coverage('cov-b','secondary','payer-b')];item=itemOf(f.markup(),'insurance');assert.match(item,/Synthetic Silver HMO/);assert.doesNotMatch(item,/more</);
 f.c.workspace.billing.coverages=[coverage('cov-old','primary','payer-a',{end_date:'2026-06-30'})];item=itemOf(f.markup(),'insurance');assert.match(item,/>Self-pay</);assert.match(item,/data-chart-section="insurance"/);assert.doesNotMatch(item,/eligibility-pill/);
 f.c.workspace.billing=null;assert.equal(itemOf(f.markup(),'insurance'),'','no insurance item without billing access');
 console.log('PASS insurance: insurer and plan, the four eligibility answers with icon and words, copay, +N more, self-pay, and nothing for a role without billing');

 // ---- Balance --------------------------------------------------------------------------
 f=fixture({now:NOW});f.c.answer.billing={patient_due_cents:4500,open_invoice_count:1,invoice_review_count:0,card_on_file:true};
 html=await f.open();item=itemOf(html,'balance');
 assert.match(item,/<span class="patient-banner-text patient-banner-owes">Owes \$45\.00<\/span>/);assert.match(item,/data-chart-section="billing"/);assert.match(item,/Patient owes \$45\.00 on 1 open invoice/);assert.match(item,/patient-banner-card">Card on file</);
 f.c.answer={...f.c.answer,billing:{patient_due_cents:0,open_invoice_count:0,invoice_review_count:2,card_on_file:false}};f.run('patientBanner.data=answer');item=itemOf(f.markup(),'balance');
 assert.match(item,/patient-banner-quiet">No balance</);assert.doesNotMatch(item,/Card on file/);assert.match(item,/2 invoices to re-check/);
 f.c.answer={...f.c.answer,billing:{patient_due_cents:123456,open_invoice_count:3,invoice_review_count:0,card_on_file:false}};f.run('patientBanner.data=answer');assert.match(itemOf(f.markup(),'balance'),/Owes \$1,234\.56/);
 const noBilling={...f.c.answer};delete noBilling.billing;f.c.answer=noBilling;f.run('patientBanner.data=answer');assert.equal(itemOf(f.markup(),'balance'),'','the server left the balance out for this role, so nothing is shown');assert.doesNotMatch(f.markup(),/No balance|Owes/);
 f=fixture({now:NOW,workspaceResourceAllowed:resource=>resource!=='billing'});f.c.answer.billing={patient_due_cents:4500,open_invoice_count:1,invoice_review_count:0,card_on_file:true};html=await f.open();assert.doesNotMatch(html,/Owes|No balance|Card on file/,'a role without billing never sees money, whatever arrives');
 f=fixture({now:NOW,chartAreaEnabled:key=>key!=='billing'&&key!=='insurance'});f.c.answer.billing={patient_due_cents:4500,open_invoice_count:1,invoice_review_count:0,card_on_file:false};f.c.workspace.billing.coverages=[coverage('cov-a','primary','payer-a')];html=await f.open();assert.doesNotMatch(html,/Owes|data-banner-item="insurance"/,'a practice that hides Billing hides it here too');
 console.log('PASS balance: owed, zero, card on file, and hidden for a role without billing access');

 // ---- Next and last visit --------------------------------------------------------------
 f=fixture({now:NOW});f.c.answer.next_appointment={id:'a1',starts_at:iso(20,9,0),ends_at:iso(20,9,30),status:'booked',title:'Office visit'};f.c.answer.last_visit={appointment_id:'a0',starts_at:iso(10,14,0),title:'Follow-up'};
 html=await f.open();item=itemOf(html,'visit-link');
 assert.match(item,/<span class="patient-banner-wide">Last: Nov 10, 2026 · <\/span>Next: Nov 20, 2026, 9:00 AM<span class="patient-banner-wide"> · Office visit<\/span>/);assert.match(item,/data-chart-section="visits"/);assert.doesNotMatch(html,/data-chart-book/);
 const next=value=>{f.c.answer={...f.c.answer,...value};f.run('patientBanner.data=answer');return f.markup();};
 html=next({next_appointment:{id:'a1',starts_at:iso(13,10,59),ends_at:iso(13,11,30),status:'in_progress',title:'Office visit'}});assert.match(itemOf(html,'visit-link'),/patient-banner-today">.*Today 10:59 AM · In progress</);
 html=next({next_appointment:{id:'a1',starts_at:iso(13,15,0),ends_at:iso(13,15,30),status:'checked_in',title:'Office visit'}});assert.match(itemOf(html,'visit-link'),/Today 3:00 PM · Checked in</);
 html=next({next_appointment:{id:'a1',starts_at:iso(13,16,0),ends_at:iso(13,16,30),status:'booked',title:'Wellness check'}});assert.match(itemOf(html,'visit-link'),/Today 4:00 PM · Wellness check</);
 html=next({next_appointment:{id:'a1',starts_at:iso(12,23,30),ends_at:iso(13,0,30),status:'in_progress',title:'Late visit'}});assert.match(itemOf(html,'visit-link'),/Nov 12, 2026, 11:30 PM · In progress</,'a visit that began yesterday is not called today');
 html=next({next_appointment:{id:'a1',starts_at:new Date(2027,0,5,9,0).toISOString(),ends_at:new Date(2027,0,5,9,30).toISOString(),status:'booked',title:'Office visit'}});assert.match(itemOf(html,'visit-link'),/Next: Jan 5, 2027, 9:00 AM/,'another year is spelled out');
 html=next({next_appointment:null,last_visit:null});assert.match(itemOf(html,'visit-link'),/patient-banner-quiet">No upcoming appointment</);assert.match(html,/<button type="button" class="text-button patient-banner-book" data-chart-book="p1">Book<\/button>/,'Book opens the existing appointment editor for this patient');assert.doesNotMatch(itemOf(html,'visit-link'),/Last:/);
 f.c.canSchedule=()=>false;assert.doesNotMatch(f.markup(),/data-chart-book/);f.c.canSchedule=()=>true;f.c.workspace.patient.archived=true;assert.doesNotMatch(f.markup(),/data-chart-book/,'an archived chart cannot be booked');
 console.log('PASS visits: next appointment, today with its status, none with Book, and the last visit alongside');

 // ---- Flags ----------------------------------------------------------------------------
 f=fixture({now:NOW});html=await f.open();assert.deepEqual(flagsOf(html),[],'no flags unless something is true');assert.doesNotMatch(html,/patient-banner-flags/);
 const flag=async(change,expected)=>{const g=fixture({now:NOW});change(g.c);const out=await g.open();assert.deepEqual(flagsOf(out),expected);return out;};
 html=await flag(c=>{c.answer.flags.intake_to_review=1;},['Intake form to review']);assert.match(html,/data-banner-flag="intake-review" data-patient-intakes-open/);
 html=await flag(c=>{c.answer.flags.intake_sent=1;},['Intake form sent']);assert.match(html,/waiting|has not finished/);
 html=await flag(c=>{c.answer.flags.portal_status='active';},['Portal active']);assert.match(html,/data-banner-flag="portal" data-portal-access="p1"/);
 await flag(c=>{c.answer.flags.portal_status='invited';},[]);await flag(c=>{c.answer.flags.portal_status='revoked';},[]);
 html=await flag(c=>{c.workspace.visits=[{id:'v1',status:'in_progress',clinician_id:'owner1'}];},['Unsigned note']);assert.match(html,/data-banner-flag="unsigned" data-chart-section="visits"/);
 await flag(c=>{c.workspace.visits=[{id:'v1',status:'signed'}];},[]);
 html=await flag(c=>{c.workspace.patient.archived=true;},['Archived']);
 html=await flag(c=>{c.workspace.billing.coverages=[coverage('cov-a','primary','payer-a')];c.answer.eligibility=[check('cov-a','completed','1',{request_snapshot:{request:{insured_given_name:'Mary',insured_family_name:'Synthetic'}}})];},['Insurer has different details']);
 assert.match(html,/data-banner-flag="differs" data-chart-section="insurance" title="The insurer&#39;s answer shows a different name\. Open Insurance to compare\."/);
 await flag(c=>{c.workspace.billing.coverages=[coverage('cov-a','primary','payer-a')];c.answer.eligibility=[check('cov-a','completed','1')];},[]);
 html=await flag(c=>{c.workspace.patient.archived=true;c.workspace.visits=[{id:'v1',status:'in_progress'}];c.answer.flags={archived:true,intake_to_review:2,intake_sent:1,portal_status:'active',unsigned_notes:1};},['Archived','Intake form to review','Intake form sent','Unsigned note','Portal active']);
 assert.match(html,/2 intake forms are waiting for review/);assert.match(html,/<dt>Flags<\/dt><dd>Archived, Intake form to review, Intake form sent, Unsigned note, Portal active<\/dd>/);
 for(const tone of ['warning','success','muted','info'])assert.match(css,new RegExp(`patient-banner-flag\\.is-${tone}\\{`));
 console.log('PASS flags: intake to review, intake sent, portal active, unsigned note, archived and insurer mismatch, each only when true');

 // ---- Escaping -------------------------------------------------------------------------
 const evil='<img src=x onerror=alert(1)>"\'&';
 f=fixture({now:NOW});Object.assign(f.c.workspace.patient,{given_name:evil,family_name:evil,mrn:evil});f.c.workspace.demographics.content={preferred_name:evil,phone:evil,email:evil,address:{line1:evil,city:evil},pronouns:evil,language:evil,administrative_gender:evil};
 f.c.workspace.clinical={items:[allergy(evil,{detail:{reaction:evil,severity:evil},verification:evil})],reviews:[]};f.c.billingPayers=[{id:'payer-a',content:{name:evil}}];f.c.workspace.billing.coverages=[coverage('cov-a','primary','payer-a',{plan_name:evil,member_id:evil}),coverage('cov-b','secondary','payer-a')];
 f.c.answer.next_appointment={id:evil,starts_at:iso(20),ends_at:iso(20,10),status:'booked',title:evil};f.c.answer.last_visit={appointment_id:'a0',starts_at:iso(10),title:evil};f.c.answer.eligibility=[check('cov-a','completed','1',{response_snapshot:{elig:[{ins_name_f:evil,ins_name_l:evil,ins_number:evil,benefit:[{benefit_coverage_code:'1'}]}]}})];
 f.c.selected=f.c.workspace.patient.id;html=await f.open();
 assert.doesNotMatch(html,/<img/,'no markup from a name, insurer, plan, allergy or appointment reaches the page');assert.doesNotMatch(html,/onerror=alert\(1\)>"/);assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
 assert.equal((html.match(/<img/g)||[]).length,0);assert.equal((html.match(/title="[^"]*"[^>]*onerror/g)||[]).length,0,'hover text cannot break out of its attribute');
 f=fixture({now:NOW,selected:'p"><script>',workspace:null});f.c.workspace={patient:{id:'p"><script>',mrn:'M',given_name:'A',family_name:'B',birth_date:'1990-01-01'},appointments:[],visits:[],clinical:{items:[],reviews:[]},billing:{coverages:[]},demographics:{content:{}}};f.c.answer={...f.c.answer,patient_id:'p"><script>',flags:{portal_status:'active'}};html=await f.open();assert.doesNotMatch(html,/<script>/);assert.match(html,/data-chart-book="p&quot;&gt;&lt;script&gt;"/);
 console.log('PASS untrusted names, insurer names, plans, allergies and appointment titles are shown as plain text');

 // ---- Primary action and More menu -----------------------------------------------------
 f=fixture({now:NOW});html=await f.open();
 const actions=out=>out.slice(out.indexOf('patient-banner-actions'),out.indexOf('patient-banner-bottom'));
 assert.match(actions(html),/<button type="button" class="primary" data-start-encounter-flow>Start visit<\/button>/);
 f.c.activeVisit={id:'v1',status:'in_progress'};assert.match(actions(f.markup()),/class="primary" data-chart-section="visits">Continue visit</);f.c.activeVisit={id:'v1',status:'signed'};assert.match(actions(f.markup()),/data-chart-section="visits">Review visit</);f.c.activeVisit=undefined;
 f.c.workspace.visits=[{id:'v-other',status:'in_progress',clinician_id:'someone'},{id:'v-mine',status:'in_progress',clinician_id:'owner1'}];assert.match(actions(f.markup()),/class="primary" data-visit="v-mine">Continue visit</,'an open note is picked up before a new visit is started');f.c.workspace.visits=[];
 f.c.workspace.appointments=[{id:'a-next-week',starts_at:iso(20),status:'checked_in',clinician_id:'owner1'},{id:'a-today',starts_at:iso(13,11),status:'checked_in',clinician_id:'owner1'}];assert.match(actions(f.markup()),/class="primary" data-start="a-today">Start visit</);
 f.c.workspace.appointments=[{id:'a-today',starts_at:iso(13,11),status:'booked',clinician_id:'owner1'}];assert.match(actions(f.markup()),/class="primary" data-check-in="a-today">Check in</);
 f.c.workspace.appointments=[{id:'a-next-week',starts_at:iso(20),status:'booked',clinician_id:'owner1'}];assert.match(actions(f.markup()),/data-start-encounter-flow>Start visit</,'an appointment on another day is not checked in from here');
 f.c.me={...f.c.me,role:'front_desk'};f.c.canStartEncounterFlow=()=>false;f.c.workspace.appointments=[];assert.doesNotMatch(actions(f.markup()),/class="primary"/);
 f.c.me={...f.c.me,role:'owner'};f.c.canStartEncounterFlow=()=>true;f.c.workspace.patient.archived=true;f.c.canStartEncounterFlow=()=>false;assert.doesNotMatch(actions(f.markup()),/class="primary"/,'nothing new starts on an archived chart');
 f=fixture({now:NOW});html=await f.open();let menu=html.slice(html.indexOf('class="patient-banner-menu"'),html.indexOf('</details>',html.indexOf('class="patient-banner-menu"')));
 // Every action the old header had, by the same data attribute its handler listens for.
 for(const action of [/<button type="button" role="menuitem" data-chart-section="profile">Contact details<\/button>/,/<button type="button" role="menuitem" data-portal-access="p1">Patient portal<\/button>/,/<button type="button" role="menuitem" data-patient-intakes-open>Intake forms<\/button>/,/<button type="button" role="menuitem" data-action="reload" aria-label="Reload patient chart">Refresh<\/button>/,/<button type="button" class="quiet support-help" data-support-help role="menuitem">Get help with this patient<\/button>/,/<button type="button" role="menuitem" class="patient-banner-danger" data-patient-lifecycle-open>Archive this patient…<\/button>/])assert.match(menu,action);
 assert.match(html,/<details class="patient-banner-more" data-banner-pop="more"><summary aria-label="More patient actions">More<\/summary><div class="patient-banner-menu" role="menu"/);
 const menuOf=g=>{const out=g.markup();return out.slice(out.indexOf('class="patient-banner-menu"'));};
 // Archive is offered only to someone the server says may manage the chart (owners always can).
 f.c.patientLifecycleStates.set('p1',{patient_id:'p1',archived:false,can_manage:false,version:1});assert.doesNotMatch(menuOf(f),/data-patient-lifecycle-open|Archive/);
 f.c.patientLifecycleStates.clear();assert.doesNotMatch(menuOf(f),/Archive/,'not offered before the server has answered');
 f.c.patientLifecycleStates.set('p1',{patient_id:'p1',archived:true,can_manage:true,version:2});f.c.workspace.patient.archived=true;assert.doesNotMatch(menuOf(f),/Archive this patient/,'an archived chart is restored from its own notice');f.c.workspace.patient.archived=false;
 f.c.patientLifecycleStates.set('p2',{patient_id:'p2',archived:false,can_manage:true,version:1});f.c.patientLifecycleStates.delete('p1');assert.doesNotMatch(menuOf(f),/Archive/,'another chart\'s permission is never used');
 f.c.me={...f.c.me,role:'nurse'};assert.doesNotMatch(menuOf(f),/Patient portal/);f.c.supportHelpButton=()=>'';assert.doesNotMatch(menuOf(f),/Get help/);f.c.chartAreaEnabled=key=>!['profile','documents'].includes(key);menu=menuOf(f);assert.doesNotMatch(menu,/Contact details|Intake forms/);assert.match(menu,/Refresh/);
 const lifecycle=read('web/patient-lifecycle.js');assert.match(lifecycle,/\[data-patient-lifecycle-open\],\[data-patient-lifecycle-cancel\]/,'the menu button opens the same form and confirmation as before');assert.doesNotMatch(lifecycle,/<summary>Archive this patient<\/summary>/,'the standalone disclosure is gone from the chart');
 console.log('PASS one context-aware primary button, and More holds every earlier header action with Archive only for people who may archive');

 // ---- Details --------------------------------------------------------------------------
 f=fixture({now:NOW});f.c.workspace.demographics.content={phone:'202-555-0101',email:'maria@example.test',address:{line1:'100 Example Street',city:'Springfield',region:'IL',postal_code:'62701'}};f.c.workspace.billing.coverages=[coverage('cov-a','primary','payer-a',{plan_name:'Gold PPO'}),coverage('cov-b','secondary','payer-b')];f.c.answer.flags.portal_status='invited';f.c.answer.last_visit={appointment_id:'a0',starts_at:iso(10),title:'Follow-up'};
 html=await f.open();const panel=html.slice(html.indexOf('patient-banner-panel'),html.indexOf('</details>'));
 for(const row of ['<dt>MRN</dt><dd>SYN-1001</dd>','<dt>Phone</dt><dd>202-555-0101</dd>','<dt>Email</dt><dd>maria@example.test</dd>','<dt>Address</dt><dd>100 Example Street, Springfield, IL, 62701</dd>','<dt>Primary insurance</dt><dd>Synthetic Health Plan · Gold PPO · Member SYN-cov-a</dd>','<dt>Secondary insurance</dt><dd>Synthetic Silver HMO · Member SYN-cov-b</dd>','<dt>Last visit</dt><dd>Nov 10, 2026 · Follow-up</dd>','<dt>Date of birth</dt><dd>Jan 1, 1990 (36)</dd>','<dt>Next appointment</dt><dd>None booked</dd>','<dt>Patient portal</dt><dd>Invited, not signed in yet</dd>'])assert.ok(panel.includes(row),row);
 f.c.workspaceResourceAllowed=resource=>resource!=='clinical';assert.doesNotMatch(f.markup(),/202-555-0101|maria@example\.test|100 Example Street/,'contact details follow the same permission as the chart');
 console.log('PASS Details holds contact, MRN, every coverage, portal status and visits one click away');

 // ---- Loading, refresh and stale charts ------------------------------------------------
 f=fixture({now:NOW});let release;f.c.answer=()=>new Promise(resolve=>{release=resolve;});const opening=f.run('patientBannerChartRendered()');
 assert.match(f.host.innerHTML,/Synthetic, Maria/,'identity and allergies paint at once from the open chart');assert.match(f.host.innerHTML,/Allergies not reviewed/);assert.match(f.host.innerHTML,/role="status">Loading…</);assert.doesNotMatch(f.host.innerHTML,/No balance|No upcoming appointment|Not checked/,'nothing is claimed before it is known');
 release({patient_id:'p1',flags:{},next_appointment:null,last_visit:null,revision:'r1',billing:{patient_due_cents:0,open_invoice_count:0,invoice_review_count:0,card_on_file:false},eligibility:[]});await opening;
 assert.match(f.host.innerHTML,/No balance/);assert.doesNotMatch(f.host.innerHTML,/Loading…/);assert.deepEqual(f.calls,[['/api/v1/patients/p1/banner','GET']]);assert.equal(f.host.style['--patient-banner-top'],'0px');
 // A save anywhere in the app repaints the banner shortly afterwards: one read for a burst of saves.
 assert.match(app,/if\(method!=='GET'&&typeof patientBannerChanged==='function'\)patientBannerChanged\(\);\n  return data;/,'every successful save reports to the banner');
 f.c.answer={patient_id:'p1',flags:{intake_to_review:1},next_appointment:{id:'a9',starts_at:iso(20),ends_at:iso(20,10),status:'booked',title:'Office visit'},last_visit:null,revision:'r2',billing:{patient_due_cents:0,open_invoice_count:0,invoice_review_count:0,card_on_file:true},eligibility:[]};
 for(let i=0;i<3;i++)f.run('patientBannerChanged()');assert.equal(f.timers.filter(timer=>!timer.cancelled).length,1);assert.equal(f.calls.length,1);await f.fire();
 assert.equal(f.calls.length,2);assert.match(f.host.innerHTML,/Next: Nov 20, 2026, 9:00 AM/);assert.match(f.host.innerHTML,/Card on file/);assert.match(f.host.innerHTML,/Intake form to review/);assert.doesNotMatch(f.host.innerHTML,/Updated — refresh/,'this person\'s own save is not reported as someone else\'s change');
 // Each listed action is a save through api(), and the ones that reload the chart repaint it too.
 for(const [file,pattern] of [['web/billing.js',/await selectPatient\(selected,activeVisit\?\.id\);showChartSection\(returnSection/],['web/clinical.js',/clinical-review\/\$\{k\}`,'POST'/],['web/clinical.js',/await selectPatient\(selected,activeVisit\?\.id\);notice\('Clinical entry saved/],['web/scheduling.js',/await selectPatient\(f\.dataset\.chartPatient/],['web/claimmd-eligibility.js',/api\(`\$\{base\}\/check`,'POST',body\)/],['web/claimmd-eligibility.js',/claimmdEligibilityRepaint\(coverageId\);\n[^\n]*\n if\(typeof patientBannerChanged==='function'\)patientBannerChanged\(\);/],['web/previsit.js',/\/review`,'POST'/],['web/patient-billing-workspace.js',/saved-card-charge`,'POST'/]])assert.match(read(file),pattern,`${file} still saves through the shared request helper`);
 assert.match(app,/applyChartSection\(\); if\(typeof patientBannerChartRendered==='function'\)void patientBannerChartRendered\(\);\n\}/,'every chart redraw repaints the banner');
 // Coming back to the tab reads again; a change that was not this person's shows a quiet chip.
 f.c.answer={...f.c.answer,revision:'r3'};for(const listener of f.listeners.visibilitychange)listener();await f.run('patientBanner.request');
 assert.equal(f.calls.length,3);assert.match(f.host.innerHTML,/<button type="button" class="patient-banner-flag is-info" data-banner-flag="stale" data-action="reload" aria-label="This chart was updated elsewhere\. Refresh"[^>]*>Updated — refresh<\/button>/);
 f.c.workspace={...f.c.workspace};await f.run('patientBannerChartRendered()');assert.doesNotMatch(f.host.innerHTML,/Updated — refresh/,'reloading the chart clears the chip');
 await f.run('patientBannerChartRendered()');for(const listener of f.listeners.visibilitychange)listener();await f.run('patientBanner.request');assert.doesNotMatch(f.host.innerHTML,/Updated — refresh/,'an unchanged chart never shows it');
 // An answer for a chart that is no longer open is dropped.
 f=fixture({now:NOW});f.c.answer=()=>new Promise(resolve=>{release=resolve;});const late=f.run('patientBannerChartRendered()');f.c.selected='p2';f.c.workspace={...f.c.workspace,patient:{...f.c.workspace.patient,id:'p2',family_name:'Other'}};f.host.innerHTML='PATIENT TWO';
 release({patient_id:'p1',flags:{},revision:'r1',billing:{patient_due_cents:99900,open_invoice_count:1,invoice_review_count:0,card_on_file:false}});await late;assert.equal(f.host.innerHTML,'PATIENT TWO');assert.equal(f.run('patientBannerCurrent()'),false);assert.doesNotMatch(f.markup(),/999/,'one patient\'s balance never appears on another chart');
 f=fixture({now:NOW});f.c.answer={patient_id:'someone-else',flags:{},revision:'r1',billing:{patient_due_cents:99900}};html=await f.open();assert.doesNotMatch(html,/999/);assert.match(html,/Some details could not be loaded\. Use Refresh in More\./);
 f=fixture({now:NOW});f.c.answer=()=>{throw new Error('offline');};html=await f.open();assert.match(html,/Some details could not be loaded/);assert.match(html,/Synthetic, Maria/);assert.match(html,/Allergies not reviewed/,'identity and allergies stay when the extra read fails');
 f.run('clearPatientBannerSession()');assert.equal(f.run('patientBanner.data'),null);assert.equal(f.run('patientBanner.patient'),null);
 console.log('PASS loading says nothing it does not know, saves and chart reloads refresh the banner, stale charts are flagged, and late answers are dropped');

 // ---- Page structure, accessibility and styling ----------------------------------------
 const chart=app.slice(app.indexOf('function renderChart()'),app.indexOf('function canRegisterPatient()'));
 assert.match(chart,/<section id="patient-banner" class="patient-banner" aria-label="Patient summary">\$\{typeof patientBannerMarkup==='function'\?patientBannerMarkup\(\):''\}<\/section><div class="chart-context">\$\{chartNavigation\(tabs\)\}<\/div>/,'the banner is a labelled landmark and the chart tabs sit directly under it');
 assert.doesNotMatch(chart,/patient-safety|PATIENT CHART|chart-header|Longitudinal record/,'the old header and the separate allergies strip are gone');assert.match(chart,/<section id="patient-lifecycle" class="panel" hidden><\/section>/);
 assert.match(index,/<script src="\/patient-lifecycle\.js" defer><\/script><script src="\/patient-banner\.js" defer><\/script>/);assert.match(index,/<link rel="stylesheet" href="\/theme\.css"><link rel="stylesheet" href="\/patient-banner\.css">/,'loaded after the theme so both themes apply');
 assert.match(lib,/"\/patient-banner\.js"/);assert.match(lib,/"\/patient-banner\.css"/);
 f=fixture({now:NOW});f.c.workspace.billing.coverages=[coverage('cov-a','primary','payer-a')];f.c.answer.flags={intake_to_review:1,portal_status:'active'};f.c.answer.billing.patient_due_cents=4500;html=await f.open();
 // Everything that can be clicked is a real button or a summary, so the keyboard reaches all of it.
 assert.doesNotMatch(html,/<(div|span|a)[^>]*(data-chart-section|data-clinical-focus|data-action|data-portal-access|data-patient-intakes-open|data-chart-book|data-start|onclick)/);assert.doesNotMatch(html,/tabindex="-1"/);
 for(const key of ['allergies','insurance','balance','visit-link'])assert.match(itemOf(html,key),/^<button type="button"/,`${key} is keyboard reachable`);
 assert.equal((html.match(/<summary/g)||[]).length,2);assert.match(html,/<summary aria-label="More about this patient">Details<\/summary>/);
 assert.match(banner,/event\.key==='Escape'&&patientBanner\.open/);assert.match(banner,/'ArrowDown','ArrowUp','Home','End'/);
 // Collapsed copies inside More, in the order they leave the row: flags, next appointment, balance, insurance.
 assert.deepEqual([...html.matchAll(/data-banner-collapsed="([a-z]+)"/g)].map(match=>match[1]),['flags','visit','balance','insurance']);
 const widths=Object.fromEntries([...css.matchAll(/@container \(max-width:(\d+)px\)\{([^\n]*)\}/g)].flatMap(match=>[...match[2].matchAll(/\[data-banner-collapsed=([a-z]+)\]\{display:block\}/g)].map(inner=>[inner[1],Number(match[1])])));
 assert.deepEqual(Object.keys(widths),['flags','visit','balance','insurance']);assert.ok(widths.flags>widths.visit&&widths.visit>widths.balance&&widths.balance>widths.insurance,'flags go first, insurance last');
 assert.match(css,/\.patient-banner-top>\.patient-banner-flags\{display:none\}/);assert.match(css,/\.patient-banner-bottom>\.patient-banner-visit\{display:none\}/);assert.match(css,/\.patient-banner-bottom>\.patient-banner-balance\{display:none\}/);assert.match(css,/\.patient-banner-bottom>\.patient-banner-insurance\{display:none\}/);
 assert.doesNotMatch(css,/patient-banner-(allergies|name|who|facts)\{display:none/,'allergies and identity never collapse');
 assert.match(css,/^\.patient-banner\{position:sticky;top:var\(--patient-banner-top,0px\);/m,'stays in view while the chart scrolls');
 assert.match(css,/text-overflow:ellipsis/);assert.match(css,/:focus-visible\{outline:2px solid var\(--focus\)/);
 // Colour comes only from the theme, so light and dark both work and contrast follows the palette.
 assert.doesNotMatch(css.replace(/\/\*[^]*?\*\//g,'').replace(/var\(--[a-z-]+(?:,[^()]*)?\)/g,'THEME'),/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\b(?:white|black|red|green|blue|orange|yellow|gr[ae]y)\b(?!-)/,'no hard-coded colours');
 const theme=read('web/theme.css')+read('web/style.css');for(const name of new Set([...css.matchAll(/var\((--[a-z-]+)/g)].map(match=>match[1])))assert.ok(name==='--patient-banner-top'||new RegExp(`${name}:`).test(theme),`${name} is a theme variable`);
 for(const name of ['--success-bg','--warning-bg','--error-bg','--surface','--ink','--muted','--line'])assert.match(read('web/theme.css').slice(read('web/theme.css').indexOf(':root[data-theme=dark]{')),new RegExp(`${name}:`),`${name} has a dark value`);
 assert.doesNotMatch(banner,/style="|#[0-9a-fA-F]{6}\b/,'no inline colours in the markup');
 assert.doesNotMatch(banner,/Intl\.DateTimeFormat|toLocale(Date|Time)String|replaceAll\('_'/,'dates, times and status words come from display-format.js');for(const helper of ['displayDate','displayTime','displayDateTime','displayAge','displayBirthDate','displayStatus','displayCount'])assert.ok(banner.includes(helper+'('),`${helper} is used`);assert.doesNotMatch(css,/font-size:\s*[\d.]+(px|rem|em|pt)/,'type sizes come from the shared --fs tokens');
 // WCAG AA (4.5:1) for every text/background pair the banner uses, worked out from the palette in both themes.
 const palette=text=>Object.fromEntries([...text.matchAll(/(--[a-z-]+):(#[0-9a-fA-F]{3,8})/g)].map(match=>[match[1],match[2]])),themeCss=read('web/theme.css'),darkAt=themeCss.indexOf(':root[data-theme=dark]{');
 const lightPalette={...palette([...read('web/style.css').matchAll(/:root\{[^}]*\}/g)].map(match=>match[0]).join('')),...palette(themeCss.slice(themeCss.indexOf(':root{'),themeCss.indexOf(':root[data-theme=light]')))},darkPalette={...lightPalette,...palette(themeCss.slice(darkAt,themeCss.indexOf('}',darkAt)))};
 const luminance=hex=>{let h=hex.slice(1);if(h.length===3)h=[...h].map(ch=>ch+ch).join('');const [r,g,b]=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).map(v=>v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4);return 0.2126*r+0.7152*g+0.0722*b;};
 const contrast=(a,b)=>{const [hi,lo]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (hi+0.05)/(lo+0.05);};
 const used=[];for(const rule of css.replace(/\/\*[^]*?\*\//g,'').matchAll(/\{([^{}]*)\}/g)){const fg=/(?:^|;)color:var\((--[a-z-]+)\)/.exec(rule[1]),bg=/background:var\((--[a-z-]+)\)/.exec(rule[1]);if(fg&&bg)used.push([fg[1],bg[1]]);}
 assert.ok(used.length>=6,'coloured surfaces declare their text colour with them');
 for(const [fg,bg] of [...used,['--ink','--surface'],['--muted','--surface'],['--muted','--surface-soft'],['--ink','--surface-raised'],['--warning-text','--surface'],['--success-text','--surface'],['--error-text','--surface'],['--blue','--surface']])for(const [name,colours] of [['light',lightPalette],['dark',darkPalette]])assert.ok(contrast(colours[fg],colours[bg])>=4.5,`${fg} on ${bg} is ${contrast(colours[fg],colours[bg]).toFixed(2)}:1 in the ${name} theme`);
 assert.doesNotMatch(css,/color:var\(--muted\)[^{}]*background:var\(--surface-raised\)|background:var\(--surface-raised\)[^{}]*color:var\(--muted\)/,'muted text never sits on the raised surface, where it falls below AA in the light theme');
 console.log('PASS landmark with a label, keyboard reachable items, collapse order, sticky position and theme-only colours');
})().catch(error=>{console.error(error);process.exit(1);});
