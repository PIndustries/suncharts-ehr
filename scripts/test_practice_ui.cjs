// SPDX-License-Identifier: AGPL-3.0-only
// Fixture-only regression checks. This does not launch or inspect a browser.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function fixture({search = '', practice = false} = {}) {
  const nodes = new Map(), listeners = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const attributes = new Map(), classes = new Set();
      nodes.set(id, {
        innerHTML: '', value: '', hidden: false, textContent: '', title: '', dataset: {},
        get outerHTML() { return this.innerHTML; },
        set outerHTML(value) { this.innerHTML = value; },
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); },
        getAttribute(name) { return attributes.get(name); },
        classList: {contains: name => classes.has(name), remove: name => classes.delete(name), add: name => classes.add(name)},
        replaceChildren() { this.innerHTML = ''; }, reset() {}, focus() {}, scrollIntoView() {},
        querySelector() { return null; }, addEventListener() {}
      });
    }
    return nodes.get(id);
  }
  const context = vm.createContext({
    console, Date, Intl, URL, URLSearchParams, TextEncoder,
    FormData: class { constructor(form) {this.form=form;} *[Symbol.iterator]() {yield* Object.entries(this.form.values||{});} },
    location: {search}, window: {scrollTo() {},addEventListener() {}}, crypto: {randomUUID: () => 'fixture-request'},
    document: {
      getElementById: node, querySelectorAll: () => [],
      addEventListener(type, callback, options) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push({callback, options});
      }
    },
    fetch() { throw new Error('Unexpected network request during fixture bootstrap'); },
    billingWrite: () => true, canDocument: () => true,
    calls: []
  });
  const evaluate = code => vm.runInContext(code, context);
  evaluate(fs.readFileSync(path.join(root, 'web/app.js'), 'utf8'));
  if (practice) evaluate(fs.readFileSync(path.join(root, 'web/practice.js'), 'utf8'));
  return {context, evaluate, node, listeners};
}

function clinicalFixture() {
  const f = fixture();
  f.evaluate(`
    me={role:'clinician',user_id:'author'};
    selected='patient-1';workspace={appointments:[{id:'appointment-1',title:'Follow-up',starts_at:'2026-10-25T14:00:00Z',status:'in_progress'}],
      visits:[],amendments:[],clinical:{items:[],reviews:[{kind:'allergy',review_state:'no_known'}]},
      labs:{orders:[],reports:[],acknowledgments:[]},billing:{accounts:[]}};
    activeVisit={id:'visit-1',appointment_id:'appointment-1',clinician_id:'author',status:'in_progress',version:1,note:null,vitals:null};
  `);
  return f;
}

async function testEncounterStates() {
  const f = clinicalFixture();
  assert.doesNotMatch(f.evaluate('encounterDateLabel(activeVisit)'), /Invalid Date/);
  assert.equal(f.evaluate("encounterDateLabel({appointment_id:'missing'})"),'Encounter date not recorded');
  f.evaluate('renderVisit(false)');
  assert.match(f.node('encounter-progress').innerHTML, /Note incomplete/);
  assert.match(f.node('encounter-progress').innerHTML, /1\/3 lists confirmed/);
  assert.match(f.node('visit-editor').innerHTML, /data-action="sign"/);
  assert.doesNotMatch(f.node('visit-editor').innerHTML, /id="amendment-form"/);
  f.evaluate(`activeVisit.note={subjective:'S',objective:'O',assessment:'A',plan:'P'}; activeVisit.vitals={heart_rate_bpm:70}; renderVisit(false)`);
  assert.match(f.node('encounter-progress').innerHTML, /Draft saved/);
  assert.match(f.node('encounter-progress').innerHTML, /Vitals saved/);
  // A saved unsigned note must retain its sign action, not become a signed record.
  assert.match(f.node('visit-editor').innerHTML, /data-action="sign"/);
  f.evaluate(`activeVisit.status='signed';activeVisit.signed_at='2026-10-25T14:30:00Z';renderVisit(false)`);
  assert.doesNotMatch(f.node('visit-editor').innerHTML, /data-action="sign"|>Save note<|>Save vitals</);
  assert.match(f.node('visit-editor').innerHTML, /id="amendment-form"/);
  assert.match(f.node('encounter-progress').innerHTML, /Signed encounter/);
  for (const role of ['owner', 'clinician', 'front_desk', 'read_only']) {
    f.evaluate(`me.role=${JSON.stringify(role)}; activeVisit.clinician_id='another-clinician';renderVisit(false)`);
    assert.doesNotMatch(f.node('visit-editor').innerHTML, /data-action="sign"|id="amendment-form"|>Save note<|>Save vitals</, role);
    assert.match(f.node('visit-editor').innerHTML, /Documentation is read-only/, role);
  }
  f.evaluate(`me.role='front_desk';activeVisit.clinician_id='author';activeVisit.status='in_progress';renderVisit(false)`);
  assert.doesNotMatch(f.node('visit-editor').innerHTML, /data-action="sign"|>Save note</);
}

async function testDelegatedRoomingControls(){
 const f=clinicalFixture();
 for(const role of ['nurse','medical_assistant']){
  f.evaluate(`me.role=${JSON.stringify(role)};activeVisit.clinician_id='another-clinician';activeVisit.status='in_progress';renderVisit(false)`);
  assert.match(f.node('visit-editor').innerHTML,/>Save vitals</,role);
  assert.doesNotMatch(f.node('visit-editor').innerHTML,/data-action="sign"|>Save note<|id="amendment-form"/,role);
  assert.match(f.node('encounter-progress').innerHTML,/Room patient/,role);
  f.evaluate(`activeVisit.status='signed';renderVisit(false)`);
  assert.doesNotMatch(f.node('visit-editor').innerHTML,/>Save vitals<|>Save note<|data-action="sign"|id="amendment-form"/,role);
 }
 f.evaluate(`me.role='nurse';activeVisit=null;workspace.appointments=[{id:'arrived',status:'checked_in',clinician_id:'another-clinician'}]`);
 assert.match(f.evaluate('encounterWorkflow()'),/data-start="arrived"/);
 f.evaluate(`me.role='front_desk'`);
 assert.doesNotMatch(f.evaluate('encounterWorkflow()'),/data-start="arrived"/);
}

async function testVisitDrafts(){
 const f=clinicalFixture();
 f.node('note-form').dataset={visitId:'visit-1',version:'1'};
 f.node('note-form').values={subjective:'Unfinished & <safe>',objective:'',assessment:'',plan:''};
 f.evaluate('captureVisitDrafts();renderVisit(false)');
 assert.match(f.node('visit-editor').innerHTML,/Unfinished &amp; &lt;safe&gt;/);
 assert.match(f.node('visit-draft-status').textContent,/Unsaved note/);
 // An unrelated chart refresh must retain both text and its optimistic-lock version.
 f.evaluate('activeVisit={...activeVisit,version:2};renderVisit(false)');
 assert.match(f.node('visit-editor').innerHTML,/id="note-form"[^>]*data-version="1"/);
 assert.match(f.node('visit-draft-status').textContent,/saved encounter changed/);
 // Saving our own vitals advances the sibling note only from the same base revision.
 f.evaluate('activeVisit={...activeVisit,version:1};rememberVisit({...activeVisit,version:2,vitals:{heart_rate_bpm:72}},"vitals");renderVisit(false)');
 assert.match(f.node('visit-editor').innerHTML,/id="note-form"[^>]*data-version="2"/);
 assert.match(f.node('visit-editor').innerHTML,/Unfinished &amp; &lt;safe&gt;/);
 // Typing during a save response must remain marked unsaved after that save succeeds.
 f.node('note-form').values.subjective='Typed while request was in flight';
 f.evaluate('rememberVisit({...activeVisit,version:3,note:{subjective:"Earlier submitted note",objective:"",assessment:"",plan:""}},"note");renderVisit(false)');
 assert.match(f.node('visit-editor').innerHTML,/Typed while request was in flight/);
 assert.match(f.node('visit-draft-status').textContent,/Unsaved note/);
 // A different patient or encounter must never inherit this note.
 f.evaluate('selected="patient-2";renderVisit(false)');
 assert.doesNotMatch(f.node('visit-editor').innerHTML,/Unfinished/);
 f.evaluate('selected="patient-1";activeVisit={...activeVisit,id:"visit-2"};renderVisit(false)');
 assert.doesNotMatch(f.node('visit-editor').innerHTML,/Unfinished/);
 f.evaluate('activeVisit={...activeVisit,id:"visit-1",status:"signed",note:{subjective:"Saved signed note"}};renderVisit(false)');
 assert.match(f.node('visit-editor').innerHTML,/Saved signed note/);
 assert.doesNotMatch(f.node('visit-editor').innerHTML,/Unfinished/);
}

async function testEncounterSelectionRefresh(){
 const f=clinicalFixture();f.context.pending=[];
 f.evaluate(`api=async()=>({...activeVisit,id:'signed-visit',status:'signed'});run=action=>pending.push(Promise.resolve().then(action));renderChart=()=>calls.push(['chart',activeVisit.id]);renderVisit=()=>calls.push(['editor-only']);`);
 const button={id:'',type:'button',dataset:{visit:'signed-visit'},closest(){return null;},hasAttribute(){return false;}};
 f.listeners.get('click')[0].callback({target:{closest:()=>button}});
 await Promise.all(f.context.pending);
 assert.deepEqual(JSON.parse(JSON.stringify(f.context.calls)),[['chart','signed-visit']]);
}

async function testSunChartsConnection(){
 const f=fixture();
 f.evaluate(fs.readFileSync(path.join(root,'web/connect-onboarding.js'),'utf8'));
 f.evaluate('me={role:"owner"};api=async()=>({items:[]});showTool=()=>{};');
 await f.evaluate('showApps()');
 const html=f.node('tools').innerHTML;
 assert.match(html,/Connect to SunCharts/);
 assert.doesNotMatch(html,/name="(?:write|billing_read|billing_write|events|migrate)"/);
 assert.match(html,/No client secrets, installation tokens or email keys to copy/);
 assert.doesNotMatch(html,/id="client-form"|id="client-result"/);
}

function practiceHtml(f) { return ['practice-home','practice-worklist','practice-results'].map(id=>f.node(id).innerHTML).join(''); }

function practiceFixture(responses) {
  const f = fixture({practice: true});
  f.context.responses = responses;
  f.evaluate(`me={role:'owner',user_id:'author'}; showTool=title=>calls.push(['tool',title]); api=async path=>{const key=path.startsWith('/api/v1/schedule?')?'schedule':path.includes('/labs/inbox')?'results':'visits';const item=responses[key];if(item.error)throw new Error(item.error);return item;};`);
  return f;
}
const empty = () => ({schedule: {appointments: [], blocks: []}, results: {items: [], limit: 100}, visits: {items: [], total: 0, has_more: false}});

async function testPracticeQueues() {
  let f = practiceFixture(empty());
  await f.evaluate('showPracticeWorkspace()');
  f.evaluate(`practiceBoardMode='unfinished';renderPracticeWorkspace()`);
  let html = practiceHtml(f);
  assert.match(html, /No unfinished encounters/);
  assert.match(html, /No results awaiting acknowledgment/);
  assert.doesNotMatch(html, /could not be loaded/);
  const values = empty();
  values.schedule.appointments = [
    {id:'arrival-1',patient_id:'patient-1',patient_name:'<img src=x onerror=alert(1)>',mrn:'MRN-1',title:'Follow-up',provider_label:'Clinician',status:'checked_in',starts_at:'2026-10-25T14:00:00Z',ends_at:'2026-10-25T14:30:00Z'},
    {id:'cancelled-1',patient_id:'cancelled-patient',patient_name:'Cancelled Patient',status:'cancelled'}
  ];
  values.results.items = [
    {order_id:'ordinary-order',patient_id:'patient-2',patient_name:'Normal queue',mrn:'MRN-2',title:'Panel',status:'final',version:1,critical:false},
    {order_id:'critical-order',patient_id:'patient-1',patient_name:'Critical queue',mrn:'MRN-1',title:'Critical panel',status:'final',version:2,critical:true}
  ];
  values.visits = {total:1,has_more:false,items:[{visit_id:'visit-1',patient_id:'patient-1',patient_name:'Visit patient',mrn:'MRN-1',starts_at:'2026-10-25T14:00:00Z',note_saved:true,vitals_saved:false}]};
  f = practiceFixture(values);
  await f.evaluate('showPracticeWorkspace()');
  html = practiceHtml(f);
  assert.match(html, /data-practice-appointment="arrival-1"/);
  assert.doesNotMatch(html, /cancelled-patient|<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  f.evaluate(`practiceBoardMode='unfinished';renderPracticeWorkspace()`);
  html = practiceHtml(f);
  assert.match(html, /data-practice-visit="visit-1" data-practice-visit-patient="patient-1"/);
  assert.match(html, /Note saved/);
  assert.match(html, /Vitals not recorded/);
  assert.doesNotMatch(html, /cancelled-patient|<img src=x/);
  assert(html.indexOf('data-practice-result="critical-order"') < html.indexOf('data-practice-result="ordinary-order"'));
  // Exercise the actual event route, verifying the selected patient and encounter.
  f.evaluate(`showClinical=async()=>calls.push(['clinical']);selectPatient=async(p,v)=>calls.push(['patient',p,v]);showChartSection=s=>calls.push(['section',s]);`);
  const click = f.listeners.get('click').find(item => item.options === true).callback;
  let prevented = false, stopped = false;
  await click({target:{closest:()=>({id:'',dataset:{practiceVisit:'visit-1',practiceVisitPatient:'patient-1'},hasAttribute:n=>n==='data-practice-visit'})},preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});
  // run() starts the asynchronous action; drain its chained continuations.
  await new Promise(resolve => setImmediate(resolve));
  assert(prevented && stopped);
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.calls.slice(-3))), [['clinical'], ['patient','patient-1','visit-1'], ['section','visits']]);
  const failed = empty(); failed.results = {error:'<script>fixture failure</script>'};
  f = practiceFixture(failed);
  await f.evaluate('showPracticeWorkspace()');
  html = practiceHtml(f);
  assert.match(html, /Results queue could not be loaded/);
  assert.doesNotMatch(html, /No results awaiting acknowledgment|<script>/);
  assert.match(html, /&lt;script&gt;fixture failure&lt;\/script&gt;/);
  f.evaluate(`practiceBoardMode='unfinished';renderPracticeWorkspace()`);
  assert.match(practiceHtml(f), /No unfinished encounters/); // An independent queue remains usable.
}

async function testPracticeFilters() {
  const values = empty();
  values.schedule.appointments = [
    {id:'a1',patient_id:'p1',patient_name:'First Patient',mrn:'MATCH-1',status:'checked_in',starts_at:'2026-10-25T14:00:00Z',ends_at:'2026-10-25T14:30:00Z'},
    {id:'a2',patient_id:'p2',patient_name:'Second Patient',mrn:'MATCH-2',status:'in_progress',starts_at:'2026-10-25T15:00:00Z',ends_at:'2026-10-25T15:30:00Z'},
    {id:'a3',patient_id:'p3',patient_name:'Third Patient',mrn:'MATCH-3',status:'completed',starts_at:'2026-10-25T16:00:00Z',ends_at:'2026-10-25T16:30:00Z'}
  ];
  values.visits={total:101,has_more:true,items:[{visit_id:'v2',appointment_id:'a2',patient_id:'p2',patient_name:'Second Patient',mrn:'MATCH-2',clinician_id:'author',provider_label:'Dr Fixture',facility:'Clinic',room:'2',starts_at:'2026-10-25T15:00:00Z',note_saved:true,vitals_saved:true}]};
  values.results.items=[{order_id:'routine',patient_id:'p1',patient_name:'First Patient',critical:false},{order_id:'urgent',patient_id:'p2',patient_name:'Second Patient',critical:true}];
  const f=practiceFixture(values);
  await f.evaluate('showPracticeWorkspace()');
  assert.match(f.node('practice-worklist').innerHTML,/data-practice-visit="v2" data-practice-visit-patient="p2"/);
  const click=f.listeners.get('click').find(item=>item.options===true).callback;
  function dispatch(dataset,attribute){return click({target:{closest:()=>({id:'',dataset,hasAttribute:name=>name===attribute})},preventDefault(){},stopImmediatePropagation(){}});}
  await dispatch({practiceFlow:'arrivals'},'data-practice-flow');
  assert.match(f.node('practice-worklist').innerHTML,/First Patient/);
  assert.match(f.node('practice-worklist').innerHTML,/Second Patient/);
  assert.doesNotMatch(f.node('practice-worklist').innerHTML,/Third Patient/);
  await dispatch({practiceFlow:'in_progress'},'data-practice-flow');
  assert.doesNotMatch(f.node('practice-worklist').innerHTML,/First Patient|Third Patient/);
  await dispatch({practiceFlow:'completed'},'data-practice-flow');
  assert.match(f.node('practice-worklist').innerHTML,/Third Patient/);
  const input=event=>f.listeners.get('input').forEach(item=>item.callback(event));
  input({target:{id:'practice-search',value:'MATCH-1'}});
  assert.match(f.node('practice-worklist').innerHTML,/No matching patients/);
  await dispatch({},'data-practice-clear');
  assert.match(f.node('practice-worklist').innerHTML,/First Patient/);
  assert.match(f.node('practice-worklist').innerHTML,/Third Patient/);
  input({target:{id:'practice-search',value:'MATCH-2'}});
  assert.match(f.node('practice-worklist').innerHTML,/Second Patient/);
  assert.doesNotMatch(f.node('practice-worklist').innerHTML,/First Patient|Third Patient/);
  await dispatch({practiceBoard:'unfinished'},'data-practice-board');
  assert.match(f.node('practice-worklist').innerHTML,/Dr Fixture/);
  assert.match(f.node('practice-row-summary').textContent,/101 total open/);
  await dispatch({practiceResultFilter:'critical'},'data-practice-result-filter');
  assert.match(f.node('practice-results').innerHTML,/data-practice-result="urgent"/);
  assert.doesNotMatch(f.node('practice-results').innerHTML,/data-practice-result="routine"/);
}

async function testEntryRouting() {
  const id = '00000000-0000-4000-8000-000000000001';
  for (const [search, expected] of [
    [`?oauth_request=${id}&era_batch=${id}`, [['consent']]],
    [`?era_batch=${id}`, [['claims'], ['batch',id]]],
    ['?payment_settings=1', [['billing'], ['payment-settings']]],
    [`?payment_checkout=${id}&payment_settings=1`, [['billing'], ['payment',id]]],
    ['', [['practice']]]
  ]) {
    const f = fixture({search});
    f.evaluate(`api=async path=>path==='/auth/me'?{role:'owner',user_id:'author'}:{items:[],next_cursor:null};showBillingQueue=async()=>calls.push(['billing']);openPaymentSettings=async()=>calls.push(['payment-settings']);openPaymentStatus=async id=>calls.push(['payment',id]);showConsent=async()=>calls.push(['consent']);showClaimsWorkspace=async()=>calls.push(['claims']);showEraBatch=async id=>calls.push(['batch',id]);showPracticeWorkspace=async()=>calls.push(['practice']);`);
    await f.evaluate('enter()');
    assert.deepEqual(JSON.parse(JSON.stringify(f.context.calls)), expected, search);
  }
  const f = fixture();
  const boots = f.listeners.get('DOMContentLoaded');
  assert.equal(boots.length, 1);
  assert.equal(boots[0].options.once, true);
  assert.equal(f.evaluate('me'), undefined); // Loading scripts must not start authentication.
  f.evaluate(`enter=async()=>calls.push(['boot']);`);
  await boots[0].callback();
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.calls)), [['boot']]);
}

(async()=>{
  for (const [name, test] of [
    ['encounter persisted state and role-protected controls', testEncounterStates],
    ['delegated rooming controls preserve clinician signing',testDelegatedRoomingControls],
    ['unsaved encounter drafts, version conflicts, and patient isolation',testVisitDrafts],
    ['single bundled SunCharts connection setup',testSunChartsConnection],
    ['encounter selection refreshes header and chart context',testEncounterSelectionRefresh],
    ['practice queues, escaping, and encounter routing', testPracticeQueues],
    ['practice workboard filters, search, and exact resume links', testPracticeFilters],
    ['entry route precedence and deferred bootstrap', testEntryRouting]
  ]) { await test(); console.log(`PASS ${name}`); }
})().catch(error=>{console.error(error);process.exitCode=1;});
