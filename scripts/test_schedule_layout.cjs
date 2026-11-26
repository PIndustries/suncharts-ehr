// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture,appointment,DAY,plain,markerLabels}=require('./test_schedule_board_ui.cjs');
async function main(){
 const f=fixture();
 f.run('loadSchedulePreference()');
 f.load([
  appointment('a','09:00','09:30',{facility:'Synthetic North',mrn:'SYN-001'}),
  appointment('b','10:00','10:15',{clinician_id:'p2',facility:'No location',status:'checked_in'})
 ],[{appointment_id:'a',forms:{status:'submitted'},insurance:{status:'not_checked'},copay:{due_cents:2500,paid_cents:0},claim:{status:'rejected'}}]);
 const head=f.run('scheduleHeadHtml()'),rail=f.run('scheduleRailHtml()');
 assert.deepEqual([...head.matchAll(/data-schedule-view="([^"]+)"/g)].map(m=>m[1]),['day','week_grid','month','week']);
 assert.match(head,/<details class="schedule-more" data-menu><summary>More ▾<\/summary>/);
 const menu=head.slice(head.indexOf('<details class="schedule-more" data-menu>'),head.indexOf('</details>'));
 for(const action of ['data-new-block','data-schedule-zoom="compact"','data-schedule-zoom="comfortable"','data-calendar-sync','data-series-list','data-reminder-workspace','data-previsit-refresh','data-schedule-filter'])assert(menu.includes(action),action);
 assert.match(head,/data-new-appointment/);for(const label of ['Scheduled','In office','Finished','Not checked','Claims not sent','Forms to review'])assert(head.includes(label));
 assert.doesNotMatch(head,/name="date"|name="provider"/);
 assert.equal((rail.match(/data-calendar-day=/g)||[]).length,42);
 assert.match(rail,new RegExp(`data-calendar-day="${DAY}"[^>]*aria-pressed="true"`));
 assert.match(rail,/LOCATIONS/);assert.match(rail,/PROVIDERS/);assert.match(rail,/class="schedule-initials">DO/);
 f.run('scheduleDate=scheduleToday()');assert.match(f.run('scheduleRailHtml()'),/aria-current="date"/);f.run(`scheduleDate='${DAY}'`);
 assert.deepEqual(plain(f.run('scheduleDayColumns().map(c=>c.provider)')),['p1','p2']);
 assert.match(rail,/Encounter type colours/);
 assert.equal(f.run('scheduleWeekColumns().length'),14);
 const change=async target=>{for(const listener of f.listeners.get('change'))listener.callback({target});await f.c.pending;};
 await change({dataset:{scheduleProvider:'p1'},checked:false});
 assert.deepEqual(plain(f.run('scheduleDayColumns().map(c=>c.provider)')),['p2']);
 for(const view of ['scheduleDayCalendar()','scheduleWeekCalendar()','scheduleMonthCalendar()','scheduleListView()']){
  const html=f.run(view);assert.doesNotMatch(html,/data-schedule-open="a"/);assert.match(html,/data-schedule-open="b"/);
 }
 await change({dataset:{scheduleProvider:'p2'},checked:false});assert.match(f.run('scheduleDayCalendar()'),/Select a provider/);
 await change({dataset:{scheduleProvider:'p1'},checked:true});await change({dataset:{scheduleProvider:'p2'},checked:true});
 await change({dataset:{scheduleLocation:'Synthetic North'},checked:false});
 assert.deepEqual(plain(f.run('scheduleShownAppointments().map(a=>a.id)')),['b']);
 assert.equal(f.calls.filter(c=>c[0]==='api').length,0,'local checkbox filtering adds no server reads');
 await change({dataset:{scheduleLocation:'Synthetic North'},checked:true});
 for(const variant of ['day','week','compact','row']){
  const card=f.run(`scheduleCard(scheduleState.appointments[0],'${variant}')`);
  assert.match(card,/<strong class="appt-patient">Example, a<\/strong>/);assert.match(card,/9:00 · 30m · Office visit · Dr\. Dana Owner/);assert.match(card,/title="9:00 AM/);
  assert.match(card,/class="appt-marker-count"[^>]*>\+4<\/span>/);
  assert.deepEqual(markerLabels(card).map(m=>[m.label,m.tone]),[['Claim rejected','red'],['Copay $25 due','amber'],...(['day','week'].includes(variant)?[]:[['Forms in','info'],['Insurance not checked','amber']])]);
  if(['day','week'].includes(variant)){assert.match(card,/<span class="appt-clock">9:00 ·<\/span><strong class="appt-patient">/);assert.match(card,/appt-grid-type">Office visit/);assert.match(card,/appt-more-markers">\+2/);}
 }
 // Chips cannot increase hour height; slot booking uses the same fixed scale.
 const itemLayout=new Map();
 const item={dataset:{start:'540',len:'30'},style:{setProperty:(key,value)=>itemLayout.set(key,value)},closest:()=>({dataset:{gridDay:DAY}})},properties=new Map();
 const scroll={scrollTop:0,scrollLeft:0,clientHeight:420,closest:()=>geometry};
 const geometry={dataset:{first:'420',last:'1440',columns:'2'},style:{setProperty:(k,v)=>properties.set(k,v)},querySelectorAll:key=>['.grid-item','[data-start]'].includes(key)?[item]:[],querySelector:key=>key==='.grid-scroll'?scroll:key==='.grid-head'?{offsetHeight:30}:null};
 f.c.document.querySelector=key=>key==='#schedule-workspace .grid-scroll'?scroll:geometry;f.run('placeScheduleGrid()');assert.equal(properties.get('--minute'),'1.6px');assert.equal(60*parseFloat(properties.get('--minute')),96);assert.equal(itemLayout.get('--l'),'30');
 const grid=f.run('scheduleDayCalendar()');
 assert.match(grid,/class="grid-item is-short" data-start="600" data-len="15"/,'15-minute visits use the count');
 assert.match(grid,/class="grid-item" data-start="540" data-len="30"/,'longer visits retain their second line');
 item.dataset.displayLen='35';f.run('placeScheduleGrid()');assert.equal(properties.get('--minute'),'1.6px');assert.equal(itemLayout.get('--l'),'35');delete item.dataset.displayLen;
 assert.equal(scroll.scrollTop,192,'first appointment starts at the top on a historical day');
 f.c.slotColumn={dataset:{gridDay:DAY},closest:()=>({...geometry,style:{getPropertyValue:key=>properties.get(key)}})};
 assert.equal(f.run('scheduleGridTimeAt(slotColumn,192)'),`${DAY}T09:00`);
 for(const mode of ['day','week_grid']){
  f.run(`scheduleMode='${mode}';scheduleScrollMemory.clear();scheduleDate=scheduleToday()`);
  const now=new Date(),minute=now.getHours()*60+now.getMinutes();
  item.closest=()=>({dataset:{gridDay:f.run('scheduleToday()')}});item.dataset.start=String(minute);item.dataset.len='30';geometry.dataset.first='0';
  f.run('placeScheduleGrid()');assert.equal(scroll.scrollTop,Math.max(0,minute*1.6-32),'next appointment opens near the sticky header');
  if(minute<1380){
   f.run('scheduleScrollMemory.clear()');item.dataset.start=String(minute+60);f.run('placeScheduleGrid()');
   assert.equal(scroll.scrollTop,(minute+60)*1.6-32,'future appointment, rather than empty current hour, opens near the top');
  }
  scroll.scrollTop=77;scroll.scrollLeft=19;f.run('rememberScheduleScroll();placeScheduleGrid()');assert.equal(scroll.scrollTop,77);assert.equal(scroll.scrollLeft,19);
  f.run("scheduleDate='2030-11-16'");item.closest=()=>({dataset:{gridDay:'2030-11-16'}});item.dataset.start='540';f.run('placeScheduleGrid()');assert.equal(scroll.scrollTop,864,'another day gets its own initial target');
  f.run('scheduleDate=scheduleToday()');f.run('placeScheduleGrid()');assert.equal(scroll.scrollTop,77,'returning to the same day and view restores scroll');
  f.run('scheduleScrollMemory.clear()');item.closest=()=>({dataset:{gridDay:f.run('scheduleToday()')}});item.dataset.start=String(Math.max(0,minute-60));item.dataset.len='1';
  // At midnight there cannot be an earlier appointment; use no appointments then.
  const originalQuery=geometry.querySelectorAll;if(minute===0)geometry.querySelectorAll=()=>[];
  f.run('placeScheduleGrid()');assert.equal(scroll.scrollTop,minute===0?0:Math.max(0,minute-60)*1.6,'today without upcoming appointments opens on the first appointment');geometry.querySelectorAll=originalQuery;
 }
 f.run(`scheduleMode='day';scheduleDate='${DAY}'`);f.c.document.querySelector=()=>null;
 const overlaps=fixture();overlaps.load([appointment('one','09:00','10:00'),appointment('two','09:30','10:30'),appointment('three','10:30','11:00')]);
 const lanes=plain(overlaps.run(`scheduleLayoutColumn(scheduleState.appointments,'${DAY}')`));
 assert.deepEqual(lanes.map(i=>[i.lane,i.lanes]),[[0,2],[1,2],[0,1]]);
 assert.match(overlaps.run('scheduleDayCalendar()'),/data-lane="1" data-lanes="2"/);
 // Counts include every rendered card, including cancelled and no-show appointments.
 const countFixture=fixture();countFixture.load([appointment('cancel','09:00','09:30',{status:'cancelled'}),appointment('miss','10:00','10:30',{status:'no_show'})]);
 assert.match(countFixture.run('scheduleDayCalendar()'),/<small>2 appointments<\/small>/);
 countFixture.run("scheduleHiddenLocations=new Set(['No location'])");assert.doesNotMatch(countFixture.run('scheduleDayCalendar()'),/<small>2 appointments/);
 // Execute the real top-bar loading/dispatch branch: it removes the old board first.
 const entry=fixture(),app=fs.readFileSync('web/app.js','utf8');
 const dispatch=app.slice(app.indexOf('    if(navigationTitle){captureVisitDrafts();showTool(navigationTitle);'),app.indexOf("    if(button.id==='nav-workflows'){studioView="));
 assert(dispatch.includes("button.id==='nav-schedule'"));
 let onSchedule=false;const originalDollar=entry.c.$;
 entry.c.$=id=>id==='schedule-workspace'?(onSchedule?originalDollar(id):null):originalDollar(id);
 entry.c.captureVisitDrafts=()=>{};entry.c.showTool=title=>{entry.node('page-title').textContent=title;entry.node('tools').hidden=false;};
 Object.defineProperty(entry.node('tools'),'innerHTML',{set:()=>{onSchedule=false;},get:()=>''});
 entry.c.renderSchedule=()=>{onSchedule=true;};entry.c.loadScheduleMarkers=async()=>{};
 entry.c.button={id:'nav-schedule',hasAttribute:()=>false};entry.c.navigationTitle='Schedule';
 entry.store.set('suncharts.schedule.default-view.tenant.p1','day');
 await entry.run(`(async()=>{${dispatch}})()`);
 assert.deepEqual(plain(entry.run('[scheduleMode,scheduleDate]')),['day',entry.run('scheduleToday()')],'a previous explicit Day preference still works');
 await entry.run("scheduleBoardClick({dataset:{scheduleView:'week_grid'}})");assert.equal(entry.run('scheduleMode'),'week_grid','view switches apply within the page');
 await entry.run('showSchedule()');assert.equal(entry.run('scheduleMode'),'week_grid','an in-page refresh preserves the view');
 entry.run("scheduleDate='2030-11-15';scheduleScrollMemory.set(scheduleScrollKey(),{top:999,left:0})");
 entry.node('page-title').textContent='Patients & encounters';onSchedule=false;
 await entry.run(`(async()=>{${dispatch}})()`);
 assert.deepEqual(plain(entry.run('[scheduleMode,scheduleDate,scheduleScrollMemory.size]')),['week_grid',entry.run('scheduleToday()'),0],'returning to Schedule restores the view and resets the date and scroll');
 entry.node('tools').hidden=true;entry.run("scheduleMode='day';scheduleDate='2030-11-15'");await entry.run('showSchedule()');
 assert.deepEqual(plain(entry.run('[scheduleMode,scheduleDate]')),['week_grid',entry.run('scheduleToday()')],'reopening restores the view after a temporary day drilldown');
 assert.doesNotMatch(entry.run('scheduleHeadHtml()'),/data-board-action="default-view"/);
 const panel=f.run("scheduleSelected='a';schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])");
 assert.match(panel,/data-schedule-chart="patient-a">Example, a/);assert.match(panel,/MRN SYN-001 · DOB unavailable/);
 assert(panel.indexOf('INSURANCE')<panel.indexOf('STATUS'));
 assert.match(panel,/schedule-amber">Not checked/);assert.match(panel,/data-schedule-status="a"/);
 assert.match(panel,/data-open-cancel>Cancel appointment/);assert.match(panel,/data-schedule-edit="a">Edit appointment/);
 assert.match(panel,/<form id="schedule-action" data-id="a" data-version="1">/);
 assert.match(panel,/name="reason" required/);
 let cancelOpen=false,focused=false;
 const cancel={querySelector:selector=>selector==='select'?{value:''}:{focus:()=>{focused=true;}}};
 Object.defineProperty(cancel,'open',{set:value=>{cancelOpen=value;}});
 f.c.document.querySelector=selector=>selector==='.appt-panel-cancel'?cancel:null;
 await f.run("scheduleBoardClick({dataset:{},hasAttribute:name=>name==='data-open-cancel'})");
 assert(cancelOpen&&focused,'footer opens the existing cancellation reason flow');
 cancelOpen=false;await change({dataset:{scheduleStatus:'a'},value:'cancel'});assert(cancelOpen,'status selection uses that same confirmation flow');
 f.run("showSchedule=async()=>calls.push(['reload']);appointmentDetail=async id=>calls.push(['detail',id])");
 await change({dataset:{scheduleStatus:'a'},value:'check-in'});
 assert(f.calls.some(c=>c[0]==='api'&&c[1]==='/api/v1/appointments/a/check-in'&&c[2]==='POST'));
 // Each chip opens the collapsed details and focuses its matching action row.
 const chips=fixture();
 chips.load([appointment('chip','09:00','09:30',{status:'completed'})],[{appointment_id:'chip',new_patient:true,visit_id:'visit-chip',note:null,forms:{status:'sent'},insurance:{status:'not_checked',coverage_id:'coverage-chip'},copay:{due_cents:2500,paid_cents:0}}]);
 chips.c.scheduleCollectCopay=async a=>chips.calls.push(['take-payment',a.id]);
 for(const kind of ['insurance','forms','new','copay','note']){
  let opened=false,focused=false,scrolled=false;
  const details={open:false,querySelector:selector=>{assert.equal(selector,`[data-schedule-fact="${kind}"]`);return {focus:()=>{focused=true;},scrollIntoView:()=>{scrolled=true;}};}};
  chips.c.document.querySelector=selector=>selector==='.schedule-encounter-details'?details:null;
  chips.c.appointmentDetail=async id=>{assert.equal(id,'chip');opened=true;};
  await chips.run(`scheduleBoardClick({dataset:{marker:'${kind}',markerAppointment:'chip'}})`);
  assert(opened&&details.open&&focused&&scrolled,kind+' discloses its next step');
 }
 assert(chips.calls.some(call=>call[0]==='take-payment'&&call[1]==='chip'));
 assert(chips.calls.some(call=>call[0]==='section'&&call[1]==='profile'));
 const facts=chips.run('schedulePanelFacts(scheduleState.appointments[0])');
 assert.match(facts,/data-board-action="registration"[^>]*>Open registration details/);
 assert.match(facts,/data-board-action="start-note"[^>]*>Start note/);
 await chips.run("scheduleBoardClick({dataset:{boardAction:'start-note',appointment:'chip'}})");
 assert(chips.calls.some(call=>call[0]==='select'&&call[2]==='visit-chip'));
 assert(chips.calls.some(call=>call[0]==='encounter'&&call[1]==='documentation'));
 for(const status of ['not_checked','check_failed','not_active']){
  chips.run(`scheduleMarkerState.items.get('chip').insurance.status='${status}'`);
  assert.match(chips.run('schedulePanelFacts(scheduleState.appointments[0])'),/data-board-action="check-eligibility"/);
 }
 for(const status of ['sent','in_progress']){
  chips.run(`scheduleState.appointments[0].status='completed';scheduleMarkerState.items.get('chip').forms.status='${status}'`);
  assert.match(chips.run('schedulePanelFacts(scheduleState.appointments[0])'),/data-board-action="send-intake"[^>]*>Send a new link/);
 }
 chips.run("scheduleMarkerState.items.get('chip').visit_id=null");
 for(const status of ['in_progress','completed']){
  chips.run(`scheduleState.appointments[0].status='${status}'`);
  const html=chips.run('schedulePanelFacts(scheduleState.appointments[0])');
  assert.doesNotMatch(html,/data-schedule-start|>Start note</);assert.match(html,/cannot be started/);assert.match(html,/Review encounters/);
 }
 chips.run("scheduleState.appointments[0].status='checked_in'");
 assert.match(chips.run('schedulePanelNext(scheduleState.appointments[0])'),/>Start encounter</);
 const actionFacts=chips.run('schedulePanelFacts(scheduleState.appointments[0])');
 assert.match(actionFacts,/data-board-action="collect-copay"/);
 assert.match(actionFacts,/data-schedule-fact="insurance" tabindex="-1"/);
 // Keep the floating card inside narrow and wide viewports.
 properties.clear();
 const float={classList:{contains:()=>false},style:{setProperty:(k,v)=>properties.set(k,v),getPropertyValue:k=>properties.get(k)}};
 f.c.float=float;f.c.window={innerWidth:375,innerHeight:700};f.c.document.querySelectorAll=()=>[{dataset:{scheduleId:'a'},getBoundingClientRect:()=>({left:340,bottom:650})}];f.run("scheduleSelected='a';placeSchedulePanel(float)");
 assert.equal(properties.get('width'),'320px');assert.equal(properties.get('left'),'43px');assert.equal(properties.get('top'),'80px');
 f.c.window={innerWidth:300,innerHeight:400};f.run('placeSchedulePanel(float)');assert.equal(properties.get('width'),'276px');assert.equal(properties.get('left'),'12px');assert.equal(properties.get('top'),'12px');
 const css=fs.readFileSync('web/schedule-board.css','utf8');
 assert.doesNotMatch(css,/height:auto;min-height:100%|focus-within\) \.appt-markers\{[^}]*overflow:visible/);
 assert.match(css,/grid-item\{overflow:hidden;box-sizing:border-box/);
 assert.match(css,/grid-template-columns:240px minmax\(0,1fr\)/);assert.match(css,/grid-block\{[^}]*repeating-linear-gradient\(45deg/);
 assert.match(css,/\.schedule-detail\{position:fixed;inset:auto/);assert.match(css,/@media\(max-width:600px\)/);
 console.log('PASS schedule layout: today/Day entry, fixed 96px hours, initial scroll and per-view memory, visible column counts, toolbar, rail, all-view checkbox filters, all coloured status chips, details order, existing status/cancel routes, bounded anchored card and responsive structure');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
