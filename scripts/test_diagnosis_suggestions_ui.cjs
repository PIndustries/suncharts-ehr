// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// SunCharts AI diagnosis suggestions on the encounter's diagnoses editor. Synthetic data only.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/diagnosis-suggestions.js','utf8');
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
function fixture({available=true,role='clinician',can_edit=true,charges='open',allow=true,chargeCodes=[]}={}){
 const handlers={},sheets=[],calls=[],added=[],lines=[],noteButton={hidden:true,disabled:false,textContent:''},noteLine={textContent:'',innerHTML:''},timers=new Map(),notices=[];let timerId=0,visible=true;
 const host={suggest:'',querySelector(sel){return sel==='[data-diagnosis-suggest]'&&this.suggest?{remove:()=>{this.suggest='';}}:null;},append(section){this.suggest=section.html;this.placed='last';},prepend(section){this.suggest=section.html;this.placed='first';}};
 const holder={appended:[],hidden:false,append(...items){this.appended.push(...items.filter(item=>typeof item!=='string'));}};
 const replies={};
 const context=vm.createContext({console,Map,Set,Promise,selected:'p1',me:{role,user_id:'u1'},activeVisit:{id:'v1',version:3,status:'in_progress'},esc,
  $:id=>id==='visit-diagnoses'&&visible?host:id==='notice'?holder:id==='billing-account-form'&&charges==='open'?{dataset:{},querySelectorAll:sel=>sel==='[name="code"]'?chargeCodes.map(value=>({value})):[]}:null,
  chargeLinesAppend:rows=>{lines.push(...rows);return rows.map(()=>({}));},encounterChargeAccount:()=>charges==='posted'?{status:'posted'}:null,billingCan:()=>allow,
  api:async(path,method='GET',body)=>{calls.push({path,method,body});const key=`${method} ${path}`;if(path==='/api/v1/ai/local-status')return {available,model:available?'m':null};const reply=replies[key];if(typeof reply==='function')return reply(body);if(reply instanceof Error)throw reply;return reply??{status:'none',request_id:null};},
  setTimeout:(fn,delay)=>{const id=++timerId;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
  document:{querySelectorAll:()=>[],querySelector:sel=>sel==='[data-note-suggest]'?noteButton:sel==='[data-note-suggest-status]'?noteLine:null,addEventListener:(name,fn)=>{(handlers[name]??=[]).push(fn);},createElement:()=>({set innerHTML(v){this.html=v;},get firstElementChild(){return {html:this.html};},dataset:{},setAttribute(){}})},
  sheetOpen:(title,node)=>{const dialog={title,html:node.html,isConnected:true,dataset:{},classList:{add(name){dialog.cls=name;}},querySelector:()=>({replaceChildren(next){dialog.html=next.html;}})};sheets.push(dialog);return dialog;},sheetClose:dialog=>{dialog.isConnected=false;dialog.closed=true;},
  visitDiagnosisAppendRow:row=>{added.push(row);return true;},
  notice:(message,error)=>notices.push({message,error}),run:fn=>{context.pending=fn();},
  encounterNumberText:visit=>visit.encounter_number?`ENC-${String(visit.encounter_number).padStart(4,'0')}`:'',
  selectPatient:async()=>{},openPatientEncounter:async()=>{},openEncounterStep:step=>{context.opened=step;}});
 vm.runInContext(source,context);
 const data={version:3,can_edit,visit:{id:'v1'},diagnoses:[]};
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 const view=()=>{const open=sheets.filter(d=>d.isConnected).pop();return open?open.html:host.suggest;};
 return {context,host,sheets,view,calls,added,lines,noteButton,noteLine,replies,notices,holder,timers,handlers,flush,
  async mount(){context.diagnosisSuggestionsMount(host,data,'v1','p1');await flush();await flush();},
  click(name,extra={}){const attr=`data-diagnosis-suggest-${name}`,button={dataset:extra,hasAttribute:n=>n===attr,getAttribute:()=>null};for(const handler of handlers.click)handler({target:{closest:()=>button},preventDefault(){}});return flush();},
  tick(index,checked=true){const box={checked,hasAttribute:()=>false,getAttribute:()=>String(index)};for(const handler of handlers.change)handler({target:{closest:()=>box}});},
  tickProcedure(index,checked=true){const box={checked,hasAttribute:n=>n==='data-diagnosis-suggest-pick-procedure',getAttribute:()=>String(index)};for(const handler of handlers.change)handler({target:{closest:()=>box}});},
  async review(){await this.click('review');},
  hide(){visible=false;}};
}
const ready=(extra={})=>({request_id:'r1',status:'ready',position:null,suggestions:[
 {code:'E11.9',description:'Type 2 diabetes <b>without</b> complications',evidence:'stable on <i>metformin</i>',evidence_found:true,catalog_release_id:'rel1'},
 {code:'I10',description:'Essential (primary) hypertension',evidence:null,evidence_found:false,catalog_release_id:'rel1'},
 {code:'J06.9',description:'Acute upper respiratory infection',evidence:'cough',evidence_found:true,catalog_release_id:'rel1'}],
 dropped:1,model:'m',note_version:3,note_changed:false,mine:true,patient_id:'p1',encounter_number:5,error:null,...extra});
(async()=>{
 // The button is shown only when SunCharts AI is on, and only to people who may add diagnoses.
 let f=fixture({available:false});await f.mount();assert.equal(f.view(),'');assert.equal(f.calls.filter(c=>c.path.includes('diagnosis-suggestions')).length,0);
 f=fixture({role:'front_desk'});await f.mount();assert.equal(f.view(),'');assert.equal(f.calls.length,0);
 f=fixture({can_edit:false});await f.mount();assert.equal(f.view(),'');
 f=fixture();await f.mount();assert.match(f.view(),/data-diagnosis-suggest-ask>Suggest codes</);
 // Availability is asked once and remembered across redraws.
 await f.mount();await f.mount();assert.equal(f.calls.filter(c=>c.path==='/api/v1/ai/local-status').length,1);
 console.log('PASS the button shows only when SunCharts AI is on and the person may edit diagnoses, and availability is read once');

 // Asking returns at once and shows the waiting line, with the place in line only when someone is ahead.
 f=fixture();await f.mount();f.replies['POST /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'queued',position:2};
 await f.click('ask');let post=f.calls.find(c=>c.method==='POST');assert.match(post.body.request_id,/^[0-9a-f-]{36}$/);assert.deepEqual(Object.keys(post.body),['request_id']);
 assert.match(f.view(),/Waiting for a turn · <span data-diagnosis-suggest-place>2 ahead of you<\/span>/);assert.doesNotMatch(f.view(),/You can keep working|you’ll be told/);assert.match(f.view(),/data-suggest-elapsed/);assert.doesNotMatch(f.view(),/data-diagnosis-suggest-ask/);
 f=fixture();await f.mount();f.replies['POST /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'queued',position:0};await f.click('ask');assert.match(f.view(),/Reading the note…/);assert.doesNotMatch(f.view(),/ahead of you/);
 console.log('PASS asking shows the waiting line, with the place in line only when it is more than zero');

 // A queued request that was already waiting when the editor opens shows the waiting line.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'queued',position:1,mine:true};await f.mount();assert.match(f.view(),/1 ahead of you/);
 assert.ok([...f.timers.values()].some(t=>t.delay===1500),'a quick refresh is scheduled while waiting');
 console.log('PASS opening the editor shows a request that is still waiting');


 // The panel is the first thing in the editor, and says what it does before anything is asked.
 f=fixture();await f.mount();assert.equal(f.host.placed,'first');
 assert.match(f.view(),/<h4 class="suggest-title">Suggested codes<\/h4>/);assert.match(f.view(),/SunCharts AI reads the saved note and suggests diagnosis and procedure codes\./);assert.match(f.view(),/class="primary" data-diagnosis-suggest-ask>Suggest codes</);
 // Extract stage: step 1 is the current one and the line says it is reading.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'queued',position:0,stage:'extract',problems_found:null,services_found:null,started_at:new Date(Date.now()-5000).toISOString(),mine:true};await f.mount();
 assert.equal(f.host.placed,'first');assert.match(f.view(),/<li class="is-now" aria-current="step">[^]*?<b>Reading the note<\/b>/);assert.match(f.view(),/<li class="is-later">[^]*?<b>Finding matching codes<\/b>/);assert.equal((f.view().match(/is-done/g)||[]).length,0);
 assert.match(f.view(),/Reading the note…/);assert.doesNotMatch(f.view(),/Found \d/);
 assert.match(f.noteLine.textContent,/^Reading the note… \d+ s$/);
 // Choose stage: steps 1 and 2 are done, step 3 is current, and the counts are in the line.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'queued',position:0,stage:'choose',problems_found:4,services_found:2,started_at:new Date(Date.now()-5000).toISOString(),mine:true};await f.mount();
 assert.equal((f.view().match(/<li class="is-done">/g)||[]).length,2);assert.match(f.view(),/<li class="is-now" aria-current="step">[^]*?<b>Choosing the best fit<\/b>/);
 assert.match(f.view(),/Found 4 problems and 2 services in the note\. Choosing codes…/);assert.match(f.noteLine.textContent,/^Choosing codes… \d+ s$/);
 f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'queued',position:0,stage:'choose',problems_found:1,services_found:0};await f.context.diagnosisSuggestRefresh('v1');
 assert.match(f.view(),/Found 1 problem in the note\. Choosing codes…/);assert.doesNotMatch(f.view(),/service/);
 // The waiting sheet shows the same steps and none of the old sentence.
 await f.review();assert.match(f.sheets[0].html,/data-suggest-steps/);assert.doesNotMatch(f.sheets[0].html,/You can keep working/);
 // The elapsed time counts from the moment the person asked.
 f=fixture();await f.mount();f.replies['POST /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'queued',position:0};await f.click('ask');
 const waiting=vm.runInContext("diagnosisSuggestStates",f.context).get('v1');waiting.startedAt=Date.now()-12500;assert.equal(vm.runInContext("diagnosisSuggestElapsed(diagnosisSuggestStates.get('v1'))",f.context),'12 s');
 // Ready: all three steps are ticked, with Review and add as the main button.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready();await f.mount();
 assert.equal((f.host.suggest.match(/<li class="is-done">/g)||[]).length,3);assert.match(f.host.suggest,/class="primary" data-diagnosis-suggest-review>Review and add</);assert.match(f.host.suggest,/data-diagnosis-suggest-ask>Suggest again</);assert.match(f.host.suggest,/data-diagnosis-suggest-dismiss>Dismiss</);
 assert.doesNotMatch(source,/You can keep working; you’ll be told/);
 console.log('PASS the panel sits first, shows the three live steps, the counts and elapsed time, and ticks them when ready');

 // Ready in place: rows unchecked, text escaped, evidence quoted or the plain missing-sentence line.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready();await f.mount();await f.review();
 assert.equal((f.view().match(/type="checkbox"/g)||[]).length,3);assert.doesNotMatch(f.view(),/checked/);
 assert.match(f.view(),/<span class="codes-strip-code">E11\.9<\/span>/);
 assert.match(f.view(),/Type 2 diabetes &lt;b&gt;without&lt;\/b&gt; complications/);assert.doesNotMatch(f.view(),/<b>|<i>/);
 assert.match(f.view(),/“stable on &lt;i&gt;metformin&lt;\/i&gt;”/);
 assert.match(f.view(),/No matching sentence found in the note/);
 assert.match(f.view(),/Suggestions come from SunCharts AI and are read from the saved note\. Check each one against the note\./);assert.match(f.view(),/Read from the saved note\. Tick what applies; nothing is added until you choose\./);assert.match(f.view(),/<h4>Diagnoses<\/h4><p class="muted">Added to this encounter’s diagnoses<\/p>/);assert.match(f.view(),/Suggest again/);assert.doesNotMatch(f.view(),/Procedures/);
 assert.match(f.view(),/Add selected/);assert.match(f.view(),/Dismiss/);
 console.log('PASS ready suggestions appear in place, unchecked, with escaped text and quoted or missing evidence');

 // Problems with no code: a muted block under the list, escaped, and absent when there are none.
 assert.doesNotMatch(f.view(),/No code found for/);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({unmatched:[{problem:'Anxiety <b>about</b> travel',evidence:'worried about <i>flying</i>'},{problem:'Insomnia',evidence:null}]});await f.mount();await f.review();
 assert.match(f.view(),/data-diagnosis-suggest-unmatched/);assert.match(f.view(),/No code found for:/);assert.match(f.view(),/Use the diagnosis search in the codes to add these\./);
 assert.match(f.view(),/Anxiety &lt;b&gt;about&lt;\/b&gt; travel <small>“worried about &lt;i&gt;flying&lt;\/i&gt;”<\/small>/);assert.match(f.view(),/<li>Insomnia<\/li>/);assert.doesNotMatch(f.view(),/<b>about|<i>flying/);
 assert.ok(f.view().indexOf('No code found for:')>f.view().indexOf('</ul>'));assert.equal((f.view().match(/type="checkbox"/g)||[]).length,3);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({unmatched:[]});await f.mount();await f.review();assert.doesNotMatch(f.view(),/No code found for/);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({suggestions:[],unmatched:[{problem:'Insomnia',evidence:'cannot sleep'}]});await f.mount();await f.review();assert.match(f.view(),/No codes found in the note\./);assert.match(f.view(),/No code found for:/);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({unmatched:undefined});await f.mount();await f.review();assert.doesNotMatch(f.view(),/No code found for/);
 console.log('PASS problems with no code are listed under the suggestions, escaped, and hidden when there are none');

 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready();await f.mount();await f.review();
 // Add selected: the existing add path, once per ticked code, in order; then the request is dismissed.
 f.tick(2);f.tick(0);f.replies['POST /api/v1/visits/v1/diagnosis-suggestions/dismiss']={status:'dismissed'};
 await f.click('add');assert.deepEqual(f.added.map(r=>r.code),['E11.9','J06.9']);assert.equal(f.added[0].display,'Type 2 diabetes <b>without</b> complications');assert.equal(f.added[0].catalog_release_id,'rel1');
 assert.ok(f.calls.some(c=>c.path.endsWith('/dismiss')&&c.method==='POST'));assert.doesNotMatch(f.view(),/type="checkbox"/);assert.match(f.view(),/Suggest codes/);
 console.log('PASS Add selected adds each ticked code once, in order, through the existing add path and then dismisses');

 // Ticks survive a redraw; nothing ticked adds nothing.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready();await f.mount();await f.review();f.tick(1);await f.mount();assert.match(f.view(),/data-diagnosis-suggest-pick="1" checked/);
 f.tick(1,false);await f.click('add');assert.equal(f.added.length,0);assert.match(f.view(),/Tick the codes to add/);
 // Dismiss calls the dismiss route and clears the list.
 f.replies['POST /api/v1/visits/v1/diagnosis-suggestions/dismiss']={status:'dismissed'};await f.click('dismiss');assert.ok(f.calls.some(c=>c.path.endsWith('/dismiss')));assert.doesNotMatch(f.view(),/type="checkbox"/);
 console.log('PASS ticks survive redraws, nothing ticked adds nothing and Dismiss clears the list');

 // The note changed since the suggestions were made.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({note_changed:true});await f.mount();await f.review();
 assert.match(f.view(),/The note changed\. Suggest again\./);assert.doesNotMatch(f.view(),/Add selected|type="checkbox"/);assert.match(f.view(),/data-diagnosis-suggest-ask/);
 vm.runInContext("diagnosisSuggestStates",f.context).get('v1').noteChanged=false;await f.mount();f.tick(0);vm.runInContext("diagnosisSuggestStates",f.context).get('v1').noteChanged=true;await f.click('add');assert.equal(f.added.length,0);
 console.log('PASS a changed note says so and adds nothing');

 // Empty, failed and refused.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({suggestions:[]});await f.mount();await f.review();assert.match(f.view(),/No codes found in the note\./);assert.doesNotMatch(f.view(),/Add selected/);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'failed',error:'timeout',mine:true};await f.mount();
 assert.match(f.view(),/The assistant could not read the note\. Try again\./);assert.match(f.view(),/data-diagnosis-suggest-ask/);
 f=fixture();await f.mount();f.replies['POST /api/v1/visits/v1/diagnosis-suggestions']=new Error('Too many requests are waiting. Try again in a few minutes.');await f.click('ask');
 assert.match(f.view(),/Too many requests are waiting\. Try again in a few minutes\./);assert.match(f.view(),/data-diagnosis-suggest-ask/);
 f.replies['POST /api/v1/visits/v1/diagnosis-suggestions']=new Error('Write the assessment or plan first.');await f.click('ask');assert.match(f.view(),/Write the assessment or plan first\./);
 console.log('PASS empty, failed and refused requests say so plainly and let the person ask again');

 // The live notice: in place when the editor is open, otherwise the normal notice with a button.
 f=fixture();await f.mount();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready();f.context.diagnosisSuggestionsEvent('visit.diagnosis_suggestions_ready','v1');await f.flush();await f.flush();
 assert.match(f.view(),/3 diagnoses suggested/);assert.doesNotMatch(f.view(),/type="checkbox"/);assert.equal(f.notices.length,0);
 f=fixture();f.hide();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready();f.context.diagnosisSuggestionsEvent('visit.diagnosis_suggestions_ready','v1');await f.flush();await f.flush();await f.flush();
 assert.deepEqual(f.notices,[{message:'Code suggestions are ready for ENC-0005.',error:false}]);assert.equal(f.holder.appended.length,1);assert.equal(f.holder.appended[0].textContent,'Open codes');
 await f.click('open',{visitId:'v1',patientId:'p1'}).catch(()=>{});
 f=fixture();f.hide();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({mine:false});f.context.diagnosisSuggestionsEvent('visit.diagnosis_suggestions_ready','v1');await f.flush();await f.flush();await f.flush();assert.equal(f.notices.length,0);
 f=fixture();f.hide();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']={request_id:'r1',status:'failed',error:'timeout',mine:true,patient_id:'p1',encounter_number:5};f.context.diagnosisSuggestionsEvent('visit.diagnosis_suggestions_failed','v1');await f.flush();await f.flush();await f.flush();
 assert.equal(f.notices[0].error,true);assert.match(f.notices[0].message,/ENC-0005/);
 f=fixture({role:'nurse'});f.context.diagnosisSuggestionsEvent('visit.diagnosis_suggestions_ready','v1');await f.flush();assert.equal(f.calls.length,0);
 console.log('PASS a finished request appears in place, or tells only the person who asked with a button to open it');

 // Procedures: both lists, the quantity line, the visit-level message, and the unmatched block.
 const withProcedures=(extra={})=>ready({procedures:[
  {code:'64616',description:'Synthetic neck <b>injection</b>',system:'CPT',source:'practice',evidence:'neck injection to the left splenius',evidence_found:true,quantity:null,quantity_unit:null,default_units:1,modifiers:'RT',catalog_release_id:null},
  {code:'J0585',description:'Injection, onabotulinumtoxinA, 1 unit',system:'HCPCS',source:'practice',evidence:'toxin 155 units injected',evidence_found:true,quantity:155,quantity_unit:'units',default_units:1,modifiers:null,catalog_release_id:'hc1'}],
  procedures_unmatched:[{service:'Office visit',evidence:'Office visit today',reason:'level'},{service:'Ice <b>pack</b>',evidence:'ice pack applied',reason:'none'}],...extra});
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();
 assert.match(f.view(),/<h4>Diagnoses<\/h4>/);assert.match(f.view(),/<h4>Procedures<\/h4><p class="muted">Added to the charges<\/p>/);
 assert.equal((f.view().match(/data-diagnosis-suggest-pick-procedure="\d"/g)||[]).length,2);assert.equal((f.view().match(/type="checkbox"/g)||[]).length,5);
 assert.doesNotMatch(f.view(),/data-diagnosis-suggest-pick-procedure="\d" checked/);
 assert.match(f.view(),/<span class="codes-strip-code">64616<\/span> Synthetic neck &lt;b&gt;injection&lt;\/b&gt;/);assert.doesNotMatch(f.view(),/<b>injection/);
 assert.match(f.view(),/“neck injection to the left splenius”/);
 assert.match(f.view(),/data-diagnosis-suggest-quantity>155 units given</);assert.equal((f.view().match(/units given/g)||[]).length,1);
 assert.match(f.view(),/Office visit: choose the encounter level yourself\./);
 assert.match(f.view(),/No code found for:<\/p><ul><li>Ice &lt;b&gt;pack&lt;\/b&gt; <small>“ice pack applied”<\/small><\/li>/);assert.doesNotMatch(f.view(),/<li>Office visit<\/li>/);
 console.log('PASS both lists show, with the quantity given, the visit-level message and the services with no code');

 // Add selected: the diagnosis path and the charge-line path, once per ticked item.
 f.tick(0);f.tick(2);f.tickProcedure(1);f.tickProcedure(0);f.replies['POST /api/v1/visits/v1/diagnosis-suggestions/dismiss']={status:'dismissed'};
 await f.click('add');assert.deepEqual(f.added.map(r=>r.code),['E11.9','J06.9']);
 assert.equal(f.lines.length,2);assert.deepEqual(f.lines.map(l=>l.code),['64616','J0585']);
 assert.deepEqual({...f.lines[0]},{code_system:'CPT',code:'64616',description:'Synthetic neck <b>injection</b>',modifiers:'RT',units:1,catalog_release_id:''});
 assert.equal(f.lines[1].code_system,'HCPCS');assert.equal(f.lines[1].catalog_release_id,'hc1');assert.equal(f.lines[1].units,1);
 assert.ok(f.calls.some(c=>c.path.endsWith('/dismiss')));
 // Only procedures ticked: no diagnosis is added. Only diagnoses ticked: no charge line.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();f.tickProcedure(0);f.replies['POST /api/v1/visits/v1/diagnosis-suggestions/dismiss']={status:'dismissed'};await f.click('add');assert.equal(f.added.length,0);assert.deepEqual(f.lines.map(l=>l.code),['64616']);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();f.tick(1);f.replies['POST /api/v1/visits/v1/diagnosis-suggestions/dismiss']={status:'dismissed'};await f.click('add');assert.equal(f.added.length,1);assert.equal(f.lines.length,0);
 // Tick all ticks both lists.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();await f.click('all');assert.equal((f.view().match(/ checked>/g)||[]).length,5);
 // A charge table that refuses the line keeps the suggestions and says so.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();f.context.chargeLinesAppend=()=>[];f.tickProcedure(0);await f.click('add');
 assert.match(f.view(),/Some procedures could not be added to the charges\./);assert.match(f.view(),/Add selected/);
 console.log('PASS Add selected adds ticked diagnoses and ticked procedures once each, through their own paths');

 // Charges that cannot be edited: procedures are shown without checkboxes, with the reason.
 f=fixture({charges:'posted'});f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();
 assert.equal((f.view().match(/type="checkbox"/g)||[]).length,3);assert.doesNotMatch(f.view(),/pick-procedure/);
 assert.match(f.view(),/Charges are posted\. Add a correction from Billing\./);assert.match(f.view(),/<span class="codes-strip-code">J0585<\/span>/);
 f.tick(0);await f.click('add');assert.equal(f.added.length,1);assert.equal(f.lines.length,0);
 f=fixture({charges:'none',allow:false});f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();assert.doesNotMatch(f.view(),/pick-procedure/);assert.match(f.view(),/You do not have permission to change charges\./);
 f=fixture({charges:'none'});f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();assert.match(f.view(),/Open the charges to add procedures\./);
 console.log('PASS procedures are shown without checkboxes, and why, when the charges cannot be edited');

 // A procedure code already typed into the charge table is shown disabled and is never added again.
 f=fixture({chargeCodes:[' 64616 ']});f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();
 assert.equal(vm.runInContext("diagnosisSuggestOnCharges('64616')",f.context),true);assert.equal(vm.runInContext("diagnosisSuggestOnCharges('J0585')",f.context),false);
 assert.match(f.view(),/data-diagnosis-suggest-pick-procedure="0"\s+disabled>/);assert.doesNotMatch(f.view(),/pick-procedure="0"[^>]*checked/);
 assert.match(f.view(),/data-diagnosis-suggest-pick-procedure="1"\s*>/);assert.doesNotMatch(f.view(),/pick-procedure="1"[^>]*disabled/);assert.match(f.view(),/Already on the charges/);assert.equal((f.view().match(/Already on the charges/g)||[]).length,1);
 f.tickProcedure(0);f.tickProcedure(1);f.replies['POST /api/v1/visits/v1/diagnosis-suggestions/dismiss']={status:'dismissed'};await f.click('add');
 assert.deepEqual(f.lines.map(l=>l.code),['J0585']);
 f=fixture({chargeCodes:[]});f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();assert.doesNotMatch(f.view(),/Already on the charges|disabled/);
 f=fixture({charges:'none'});assert.equal(vm.runInContext("diagnosisSuggestOnCharges('64616')",f.context),false);
 console.log('PASS a procedure already on the charges is shown disabled and is not added again; the helper is safe without the form');

 // Procedures only, and the level message alone, still show.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures({suggestions:[],unmatched:[]});await f.mount();await f.review();assert.doesNotMatch(f.view(),/<h4>Diagnoses/);assert.match(f.view(),/<h4>Procedures<\/h4><p class="muted">Added to the charges<\/p>/);assert.doesNotMatch(f.view(),/No codes found in the note/);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({suggestions:[],procedures:[],procedures_unmatched:[{service:'Office visit',evidence:null,reason:'level'}]});await f.mount();await f.review();
 assert.match(f.view(),/No codes found in the note\./);assert.match(f.view(),/Office visit: choose the encounter level yourself\./);assert.doesNotMatch(f.view(),/No code found for/);
 console.log('PASS procedures alone, and a visit left to the clinician alone, are shown');

 // The button beside Save note and its status line.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();
 assert.equal(f.noteButton.textContent,'Suggest codes again');assert.match(f.noteLine.innerHTML,/^3 diagnoses and 2 procedures ready · <button[^>]*data-note-suggest-review>Review<\/button>$/);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({suggestions:[ready().suggestions[0]]});await f.mount();await f.review();assert.match(f.noteLine.innerHTML,/^1 diagnosis ready · /);
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=ready({suggestions:[],procedures:[withProcedures().procedures[0]]});await f.mount();await f.review();assert.match(f.noteLine.innerHTML,/^1 procedure ready · /);
 f=fixture();await f.mount();assert.equal(f.noteButton.textContent,'Suggest codes');
 console.log('PASS the button beside Save note and its status line count diagnoses and procedures');

 // The editor keeps one line; the list opens in a sheet from Review, on the note or in the editor.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();
 assert.match(f.host.suggest,/3 diagnoses and 2 procedures suggested/);assert.match(f.host.suggest,/data-diagnosis-suggest-review>Review and add</);assert.doesNotMatch(f.host.suggest,/type="checkbox"|diagnosis-suggest-list|<h4>/);assert.equal(f.sheets.length,0);
 const noteReview=()=>{const button={dataset:{},hasAttribute:n=>n==='data-note-suggest-review',getAttribute:()=>null};for(const handler of f.handlers.click)handler({target:{closest:()=>button},preventDefault(){}});return f.flush();};
 await noteReview();assert.equal(f.sheets.length,1);assert.equal(f.sheets[0].title,'Suggested codes');assert.equal(f.sheets[0].cls,'sheet-wide');
 assert.match(f.sheets[0].html,/^<div data-diagnosis-suggest /);assert.match(f.sheets[0].html,/<h4>Procedures<\/h4>/);assert.match(f.sheets[0].html,/Added to the charges/);
 assert.match(f.sheets[0].html,/data-diagnosis-suggest-add>Add selected</);
 // Review again, or a change while it is open, repaints the same sheet instead of opening another.
 await noteReview();assert.equal(f.sheets.length,1);
 f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures({note_changed:true});await f.context.diagnosisSuggestRefresh('v1');assert.equal(f.sheets.length,1);assert.match(f.sheets[0].html,/The note changed\. Suggest again\./);
 f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.context.diagnosisSuggestRefresh('v1');assert.equal(f.sheets.length,1);assert.match(f.sheets[0].html,/type="checkbox"/);
 // Closing the sheet keeps the suggestions.
 f.sheets[0].isConnected=false;assert.equal(vm.runInContext("diagnosisSuggestStates",f.context).get('v1').status,'ready');assert.match(f.host.suggest,/3 diagnoses and 2 procedures suggested/);
 await noteReview();assert.equal(f.sheets.length,2);
 // The button counts what is ticked.
 f.tick(0);f.tickProcedure(1);f.tickProcedure(0);
 await f.click('all');assert.match(f.sheets[1].html,/data-diagnosis-suggest-add>Add 5 selected</);
 // Add selected closes the sheet and says what was added.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();
 f.tick(0);f.tick(2);f.tickProcedure(0);f.replies['POST /api/v1/visits/v1/diagnosis-suggestions/dismiss']={status:'dismissed'};
 await f.click('add');await f.flush();assert.equal(f.sheets[0].closed,true);assert.deepEqual(f.notices,[{message:'Added 2 diagnoses and 1 procedure.',error:undefined}]);
 assert.equal(f.sheets.length,1);assert.doesNotMatch(f.host.suggest,/Review/);
 // Nothing ticked leaves the sheet open with the reason.
 f=fixture();f.replies['GET /api/v1/visits/v1/diagnosis-suggestions']=withProcedures();await f.mount();await f.review();await f.click('add');assert.equal(f.sheets[0].closed,undefined);assert.match(f.sheets[0].html,/Tick the codes to add/);
 // Dismiss closes the sheet.
 f.replies['POST /api/v1/visits/v1/diagnosis-suggestions/dismiss']={status:'dismissed'};await f.click('dismiss');assert.equal(f.sheets[0].closed,true);
 console.log('PASS the list opens in a sheet from Review and is not drawn in the editor; Add selected closes it and says what was added');

 // The editor wiring and the live feed hand-off exist in the shipped scripts.
 const diagnoses=fs.readFileSync('web/visit-diagnoses.js','utf8'),events=fs.readFileSync('web/sun-events.js','utf8'),index=fs.readFileSync('web/index.html','utf8');
 assert.match(diagnoses,/diagnosisSuggestionsMount\(host,data,id,patient\)/);assert.match(diagnoses,/function visitDiagnosisAppendRow/);
 assert.match(events,/diagnosis_suggestions_\(ready\|failed\)[\s\S]*diagnosisSuggestionsEvent/);assert.match(index,/diagnosis-suggestions\.js/);
 console.log('PASS the editor, the live feed and the page load the suggestions');
})().catch(error=>{console.error(error);process.exitCode=1;});
