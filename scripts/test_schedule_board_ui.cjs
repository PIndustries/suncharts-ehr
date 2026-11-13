// SPDX-License-Identifier: AGPL-3.0-only
// Schedule board: default view, time grid, appointment card, markers, panel actions,
// summary filters and month overflow. Synthetic fixtures only; no browser or server.
'use strict';
process.env.TZ='America/Chicago';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const sources=['web/scheduling.js','web/schedule-board.js'].map(read);
const plain=value=>JSON.parse(JSON.stringify(value));
// A fixed Friday that is never today, so the current-time line is predictable.
const DAY='2030-11-15',at=(time,day=DAY)=>new Date(`${day}T${time}:00-06:00`).toISOString();
const appointment=(id,start,end,extra={})=>({id,version:1,patient_id:'patient-'+id,clinician_id:'p1',starts_at:at(start),ends_at:at(end),status:'booked',title:'Office visit',category:'Office visit',facility:'',room:'',notes:'',patient_name:'Example, '+id,provider_label:'owner@example.test',...extra});

function fixture(options={}){
 const nodes=new Map(),listeners=new Map(),calls=[],store=options.store||new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',hidden:true,dataset:{},classList:{add(){},remove(){},toggle(){}},closest(){return this;},querySelector(){return null;},contains(){return false;}});return nodes.get(id);};
 const replies=options.replies||{};
 const c=vm.createContext({Date,Intl,URLSearchParams,console,Map,Set,JSON,Math,Number,String,Array,Object,Promise,Error,
  crypto:{randomUUID:()=>`request-${calls.length}`},location:{origin:'http://localhost:8099'},
  localStorage:options.brokenStorage?{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}}:{getItem:key=>store.has(key)?store.get(key):null,setItem:(key,value)=>{store.set(key,String(value));}},
  document:{getElementById:node,addEventListener(type,callback,capture){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({callback,capture});},visibilityState:'visible',activeElement:null},
  localTime:value=>{const d=new Date(value),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;},
  esc:value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
  date:value=>new Date(value).toISOString(),me:{role:'owner',user_id:'p1',tenant_id:'tenant'},$:node,calls,
  showTool:name=>calls.push(['tool',name]),notice:(message,error=false)=>calls.push(['notice',message,error]),
  run:work=>{c.pending=Promise.resolve().then(work);return c.pending;},
  showClinical:async()=>calls.push(['clinical']),selectPatient:async(id,visit)=>{calls.push(['select',id,visit]);c.selected=id;c.workspace={appointments:plain(vm.runInContext('scheduleState?scheduleState.appointments:[]',c))};if(visit)c.activeVisit={id:visit};},
  showChartSection:key=>calls.push(['section',key]),setEncounterSection:key=>calls.push(['encounter',key]),openWorkflowIntakePacket:async id=>calls.push(['intake',id]),
  insuranceAppointmentSelection:new Map(),selected:undefined,workspace:undefined,activeVisit:undefined,
  workspaceResourceAllowed:(resource,action)=>!(options.denied||[]).includes(resource),
  api:async(route,method='GET',body,version)=>{
   calls.push(['api',route,method,body,version]);
   for(const [pattern,reply] of Object.entries(replies))if(route.includes(pattern)&&(reply.method||'GET')===method){const value=typeof reply.value==='function'?reply.value(route,body):reply.value;if(value instanceof Error)throw value;return value;}
   if(route.endsWith('/schedule/providers'))return {items:c.fixtureProviders,hours:c.fixtureHours};
   if(route.includes('/schedule/markers?'))return {items:c.fixtureMarkers,billing:true,insurance:true,clinical:true};
   if(route.includes('/schedule?'))return {appointments:c.fixtureAppointments,blocks:c.fixtureBlocks};
   return {};
  }
 });
 c.fixtureProviders=[{id:'p1',label:'Dr. Dana Owner'},{id:'p2',label:'Dr. Sam Rivera'}];c.fixtureHours=null;c.fixtureMarkers=[];c.fixtureAppointments=[];c.fixtureBlocks=[];
 const run=code=>vm.runInContext(code,c);
 for(const source of sources)run(source);
 run(`scheduleDate='${DAY}';scheduleProviders=fixtureProviders`);
 const load=(appointments,markers=[],blocks=[])=>{c.fixtureAppointments=appointments;c.fixtureMarkers=markers;c.fixtureBlocks=blocks;c.given={appointments,blocks,markers};run("scheduleState={appointments:given.appointments,blocks:given.blocks};scheduleMarkerState={key:'k',items:new Map(given.markers.map(m=>[m.appointment_id,m])),loaded:true,failed:false}");};
 const click=async dataset=>{const button={dataset,type:'button',textContent:'',hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,x)=>x.toUpperCase())),closest:selector=>selector==='button'||selector==='#schedule-workspace'?button:null};for(const listener of listeners.get('click'))if(!listener.capture)listener.callback({target:{closest:selector=>selector==='button'?button:null,hasAttribute:()=>false}});await c.pending.catch(()=>{});};
 return {c,run,node,listeners,calls,store,load,click};
}
const markerLabels=html=>[...html.matchAll(/class="appt-marker tone-([a-z]+)" data-marker="([a-z]+)"[^>]*title="([^"]*)">.*?<span>([^<]*)<\/span>/g)].map(m=>({tone:m[1],kind:m[2],tip:m[3],label:m[4]}));

async function main(){
 // ---- Default view and what is remembered on this device ----
 let f=fixture();
 f.run('loadSchedulePreference()');
 assert.equal(f.run('scheduleMode'),'day','a device with no saved choice opens on the day view');
 f.run("scheduleMode='week_grid';saveSchedulePreference();scheduleProvider='11111111-1111-4111-8111-111111111111';saveSchedulePreference('provider');scheduleZoom='compact';saveSchedulePreference('zoom')");
 assert.deepEqual([...f.store.keys()].sort(),['suncharts.schedule.default-view.tenant.p1','suncharts.schedule.default-view.tenant.p1.provider','suncharts.schedule.default-view.tenant.p1.zoom']);
 let again=fixture({store:f.store});again.run('loadSchedulePreference()');
 assert.deepEqual(plain(again.run('[scheduleMode,scheduleProvider,scheduleZoom]')),['week_grid','11111111-1111-4111-8111-111111111111','compact'],'view, provider and row height come back on the same device');
 again.c.me={role:'front_desk',user_id:'someone-else',tenant_id:'tenant'};again.run("scheduleProvider='';loadSchedulePreference()");
 assert.deepEqual(plain(again.run('[scheduleMode,scheduleProvider,scheduleZoom]')),['day','','comfortable'],'another staff member on the device starts from the default');
 const junk=fixture({store:new Map([['suncharts.schedule.default-view.tenant.p1','sideways'],['suncharts.schedule.default-view.tenant.p1.provider','<script>']])});junk.run('loadSchedulePreference()');
 assert.deepEqual(plain(junk.run('[scheduleMode,scheduleProvider]')),['day',''],'a damaged saved choice is ignored');
 const blocked=fixture({brokenStorage:true});blocked.run("loadSchedulePreference();scheduleMode='month';saveSchedulePreference()");
 assert.equal(blocked.run('scheduleMode'),'month','blocked storage never breaks the page');
 // A remembered provider who has left the practice is forgotten instead of hiding the day.
 const gone=fixture({store:new Map([['suncharts.schedule.default-view.tenant.p1.provider','99999999-9999-4999-8999-999999999999']])});
 gone.c.fixtureAppointments=[appointment('a','09:00','09:30')];await gone.run('showSchedule()');
 assert.equal(gone.run('scheduleProvider'),'');assert.equal(gone.store.get('suncharts.schedule.default-view.tenant.p1.provider'),'');
 assert.equal(gone.calls.filter(call=>call[0]==='api'&&call[1].includes('/schedule?')).at(-1)[1].includes('clinician_id'),false);
 assert.match(gone.node('tools').innerHTML,/class="schedule-grid schedule-grid-day zoom-comfortable"/,'the day grid is what opens');

 // ---- Cards first, markers from one read per visible range ----
 f=fixture();let releaseMarkers;const markerGate=new Promise(resolve=>{releaseMarkers=resolve;});
 f.c.fixtureAppointments=[appointment('a','09:00','09:30'),appointment('b','10:00','10:30')];
 const markerFacts=[{appointment_id:'a',patient_id:'patient-a',new_patient:true,visit_id:null,forms:null,insurance:{status:'not_checked',coverage_id:'coverage-a'},copay:null,balance_cents:0,charges:null,note:null}];
 const slow=fixture({replies:{'/schedule/markers?':{value:async()=>{await markerGate;return {items:markerFacts};}}}});
 slow.c.fixtureAppointments=f.c.fixtureAppointments;
 await slow.run('showSchedule()');
 let html=slow.node('tools').innerHTML;
 assert.equal((html.match(/class="appt-card /g)||[]).length,2,'cards are drawn before the markers arrive');assert.doesNotMatch(html,/class="appt-marker /);
 releaseMarkers();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.match(slow.node('schedule-body').innerHTML,/data-marker="new"/,'markers fill in afterwards');
 assert.equal(slow.calls.filter(call=>call[0]==='api'&&call[1].includes('/schedule/markers?')).length,1,'one marker read for the day, whatever the number of appointments');
 assert.equal(slow.calls.filter(call=>call[0]==='api'&&/appointments\/|patients\//.test(call[1])).length,0,'no per-appointment reads');
 // The same range keeps its markers while it is read again; a new range starts clean.
 const cacheKey=slow.run('scheduleMarkerState.key');await slow.run('showSchedule()');
 assert.equal(slow.run('scheduleMarkerState.key'),cacheKey);assert.match(slow.node('tools').innerHTML,/data-marker="new"/,'a refresh of the same day shows the facts it already has');
 slow.run('shiftSchedulePeriod(1)');const next=slow.run('showSchedule()');
 await next;assert.notEqual(slow.run('scheduleMarkerState.key'),cacheKey);
 const failing=fixture({replies:{'/schedule/markers?':{value:new Error('offline')}}});failing.c.fixtureAppointments=[appointment('a','09:00','09:30')];
 await failing.run('showSchedule()');await new Promise(resolve=>setImmediate(resolve));
 assert.match(failing.node('schedule-head').innerHTML,/could not be loaded/);assert.match(failing.node('tools').innerHTML,/class="appt-card /,'the schedule still works without markers');

 // ---- Grid positions ----
 f=fixture();
 let layout=plain(f.run(`scheduleLayoutColumn(${JSON.stringify([appointment('a','09:00','09:30'),appointment('b','10:00','10:45')])},'${DAY}')`)).map(i=>[i.a.id,i.start,i.shownEnd-i.start,i.lane,i.lanes]);
 assert.deepEqual(layout,[['a',540,30,0,1],['b',600,45,0,1]],'typical visits fill the column at their own time and length');
 layout=plain(f.run(`scheduleLayoutColumn(${JSON.stringify([appointment('a','09:00','10:00'),appointment('b','09:30','10:00'),appointment('c','09:45','10:15'),appointment('d','10:00','10:30'),appointment('e','11:00','11:05')])},'${DAY}')`)).map(i=>[i.a.id,i.start,i.shownEnd-i.start,i.lane,i.lanes]);
 assert.deepEqual(layout,[['a',540,60,0,3],['b',570,30,1,3],['c',585,30,2,3],['d',600,30,0,3],['e',660,15,0,1]],'overlapping visits sit side by side; a free lane is reused; a very short visit keeps a readable height');
 // Before opening, after closing and across midnight.
 f.load([appointment('early','05:30','06:00'),appointment('late','19:30','20:15'),appointment('night','23:30','23:59',{ends_at:new Date('2030-11-16T00:30:00-06:00').toISOString()})]);
 assert.deepEqual(plain(f.run('scheduleGridRange(scheduleDayColumns())')),{first:300,last:1440},'the grid grows to fit visits outside opening hours');
 assert.deepEqual(plain(f.run(`scheduleDayMinutes(scheduleState.appointments[2],'${DAY}')`)),{start:1410,end:1440});
 assert.deepEqual(plain(f.run(`scheduleDayMinutes(scheduleState.appointments[2],'2030-11-16')`)),{start:0,end:30});
 f.load([appointment('a','09:00','09:30')]);
 assert.deepEqual(plain(f.run('scheduleGridRange(scheduleDayColumns())')),{first:420,last:1140},'7am to 7pm when the practice has not set its hours');
 f.run("scheduleHours={start:'08:00',end:'17:00',timezone:'America/Chicago'}");
 assert.deepEqual(plain(f.run('scheduleGridRange(scheduleDayColumns())')),{first:480,last:1020},'the practice hours are used when set');
 assert.equal(f.run('scheduleZoneNote()'),'','no time zone note when the practice and this computer agree');
 f.run("scheduleHours={start:'08:00',end:'17:00',timezone:'America/New_York'}");
 assert.deepEqual(plain(f.run('scheduleGridRange(scheduleDayColumns())')),{first:420,last:960},'hours kept in another time zone are shown on this computer’s clock');
 assert.match(f.run('scheduleZoneNote()'),/America\/New_York/);assert.match(f.run('scheduleHeadHtml()'),/class="muted schedule-zone"/);
 f.run("scheduleHours={start:'08:00',end:'17:00',timezone:'Not/AZone'}");assert.deepEqual(plain(f.run('scheduleGridRange(scheduleDayColumns())')),{first:420,last:1140});
 f.run('scheduleHours=null');
 html=f.run('scheduleDayCalendar()');
 assert.match(html,/data-first="420" data-last="1140" data-columns="1"/);assert.match(html,/class="grid-item" data-start="540" data-len="30" data-lane="0" data-lanes="1"/);
 assert.equal((html.match(/class="grid-hour"/g)||[]).length,12);assert.doesNotMatch(html,/data-now-line/,'no current-time line on another day');
 assert.doesNotMatch(html,/ style="/,'geometry is set through the style API, never inline attributes');
 f.run(`scheduleDate=scheduleToday()`);f.load([]);assert.match(f.run('scheduleDayCalendar()'),/data-now-line hidden/,'today carries the current-time line');f.run(`scheduleDate='${DAY}'`);
 assert.equal(f.run("scheduleGridTimeAt({dataset:{gridDay:'2030-11-15'},closest:()=>({dataset:{first:'420'}})},(14*60+20-420)*2)"),'2030-11-15T14:15','a click lands on the quarter hour it falls in');

 // ---- Provider columns only when needed ----
 const columns=()=>plain(f.run('scheduleDayColumns()')).map(col=>[col.provider,col.label,col.appointments.length,col.blocks.length]);
 f.load([appointment('a','09:00','09:30'),appointment('b','10:00','10:30')]);
 assert.deepEqual(columns(),[['p1','Dr. Dana Owner',2,0]],'one provider: a single wide column');
 f.load([]);assert.deepEqual(columns(),[['','All providers',0,0]]);
 f.load([appointment('a','09:00','09:30'),appointment('b','10:00','10:30',{clinician_id:'p2'})]);
 assert.deepEqual(columns(),[['p1','Dr. Dana Owner',1,0],['p2','Dr. Sam Rivera',1,0]],'two providers with visits: a column each');
 f.load([appointment('a','09:00','09:30')],[],[{id:'lunch',clinician_id:'p2',starts_at:at('12:00'),ends_at:at('13:00'),label:'Lunch',version:1}]);
 assert.deepEqual(columns(),[['p1','Dr. Dana Owner',1,0],['p2','Dr. Sam Rivera',0,1]],'a blocked provider keeps a column so the block has a place');
 html=f.run('scheduleDayCalendar()');assert.match(html,/class="grid-block"[^>]*data-schedule-block="lunch" data-start="720" data-len="60"/);assert.match(html,/data-grid-provider="p2"/);
 f.run("scheduleProvider='p2'");f.load([appointment('b','10:00','10:30',{clinician_id:'p2'})]);
 assert.deepEqual(columns(),[['p2','Dr. Sam Rivera',1,0]],'a chosen provider: a single wide column');
 f.run("scheduleProvider=''");f.load([]);assert.deepEqual(columns(),[['','All providers',0,0]]);
 // A provider who has left still shows the visits they had.
 f.load([appointment('a','09:00','09:30'),appointment('old','10:00','10:30',{clinician_id:'left',provider_label:'Dr. Former'})]);
 assert.deepEqual(columns().map(col=>col[1]),['Dr. Dana Owner','Dr. Former']);

 // ---- Status wording ----
 assert.deepEqual(plain(f.run("['booked','checked_in','in_progress','completed','cancelled','no_show'].map(scheduleStatusLabel)")),['Booked','Checked in','In progress','Completed','Cancelled','No-show']);
 assert.equal(f.run("scheduleStatusLabel('awaiting_review')"),'Awaiting review','an unknown state is shown as recorded, in sentence case');
 assert.equal(Object.keys(plain(f.run('scheduleStatusLabels'))).includes('confirmed'),false,'no state is invented');
 html=f.run(`scheduleCard(${JSON.stringify(appointment('a','09:00','09:30',{status:'checked_in',category:'Telehealth',title:'Video visit'}))},'day')`);
 assert.match(html,/class="appt-card appt-day status-checked_in type-telehealth"/,'status and visit type are separate channels');
 assert.match(html,/<span class="appt-status">Checked in<\/span>/,'the status is always written out, never colour alone');
 assert.match(html,/<span class="appt-time">9:00 AM<span class="appt-time-end"> – 9:30 AM<\/span><\/span><strong class="appt-patient">Example, a<\/strong><span class="appt-meta">Video visit · Dr. Dana Owner<\/span>/);
 assert.doesNotMatch(html,/owner@example\.test/,'the provider is named, not shown by sign-in email');
 f.run('scheduleProviders=[]');assert.match(f.run(`scheduleCard(${JSON.stringify(appointment('a','09:00','09:30'))},'day')`),/owner@example\.test/,'the email is the last resort when no name exists');
 f.run("scheduleProviders=[{id:'p1',label:'Dr. Dana Owner'},{id:'p2',label:'Dr. Sam Rivera'}]");
 assert.deepEqual(plain(f.run("['Office visit','New patient','Follow-up','Telehealth','Procedure','Nurse check',''].map(category=>scheduleVisitType({category}))")),['office','new','followup','telehealth','procedure','other','other']);

 // ---- Every marker state, and its absence ----
 const base={appointment_id:'a',patient_id:'patient-a',new_patient:false,visit_id:null,forms:null,insurance:{status:'self_pay'},copay:null,balance_cents:0,charges:null,note:null};
 const markersFor=(facts,status='booked',variant='day')=>{f.load([appointment('a','09:00','09:30',{status})],[{...base,...facts}]);return markerLabels(f.run(`scheduleMarkersHtml(scheduleState.appointments[0],'${variant}')`));};
 const one=(facts,kind,status)=>markersFor(facts,status).filter(m=>m.kind===kind).map(m=>[m.label,m.tone]);
 assert.deepEqual(one({forms:{status:'sent',packet_id:'k'}},'forms'),[['Forms sent','grey']]);
 assert.deepEqual(one({forms:{status:'in_progress',packet_id:'k'}},'forms'),[['Forms started','grey']]);
 assert.deepEqual(one({forms:{status:'submitted',packet_id:'k'}},'forms'),[['Forms in','amber']]);
 assert.deepEqual(one({forms:{status:'reviewed',packet_id:'k'}},'forms'),[['Forms done','green']]);
 assert.deepEqual(one({forms:null},'forms'),[],'nothing when no form was sent');
 f.load([appointment('a','09:00','09:30')],[base]);html=f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')");
 assert.match(html,/class="appt-marker appt-marker-offer" data-board-action="send-intake" data-appointment="a"[^>]*>.*Send intake form/,'with no form sent, the card offers to send one');
 f.c.me.role='nurse';assert.doesNotMatch(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')"),/send-intake/);f.c.me.role='owner';
 f.load([appointment('a','09:00','09:30',{status:'completed'})],[base]);assert.doesNotMatch(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')"),/send-intake/,'not offered once the visit is over');
 assert.deepEqual(one({insurance:{status:'active',coverage_id:'c'}},'insurance'),[['Active','green']]);
 assert.deepEqual(one({insurance:{status:'not_active',coverage_id:'c'}},'insurance'),[['Not active','red']]);
 assert.deepEqual(one({insurance:{status:'not_checked',coverage_id:'c'}},'insurance'),[['Not checked','grey']]);
 assert.deepEqual(one({insurance:{status:'check_failed',coverage_id:'c'}},'insurance'),[['Check failed','amber']]);
 assert.deepEqual(one({insurance:{status:'self_pay'}},'insurance'),[['Self-pay','grey']]);
 assert.deepEqual(one({copay:{due_cents:1500,paid_cents:0,test_paid_cents:0}},'copay'),[['$15 due','amber']]);
 assert.deepEqual(one({copay:{due_cents:2550,paid_cents:1000,test_paid_cents:0}},'copay'),[['$15.50 due','amber']],'part payments leave the rest due');
 assert.deepEqual(one({copay:{due_cents:1500,paid_cents:1500,test_paid_cents:0}},'copay'),[['Copay paid','green']]);
 assert.deepEqual(one({copay:{due_cents:0,paid_cents:2000,test_paid_cents:0}},'copay'),[['Copay paid','green']]);
 assert.deepEqual(one({copay:{due_cents:1500,paid_cents:0,test_paid_cents:1500}},'copay'),[['Copay paid (test)','grey']],'a test card payment never reads as money received');
 assert.deepEqual(one({copay:null},'copay'),[],'nothing when no copay is recorded');
 assert.deepEqual(one({copay:{due_cents:1500,paid_cents:0,test_paid_cents:0}},'copay','cancelled'),[],'a cancelled visit has no copay to collect');
 assert.deepEqual(one({balance_cents:4500},'balance'),[['Owes $45','amber']]);assert.deepEqual(one({balance_cents:0},'balance'),[]);
 assert.deepEqual(one({new_patient:true},'new'),[['New patient','info']]);assert.deepEqual(one({new_patient:false},'new'),[]);
 // Unfinished work on a finished visit stands out.
 assert.deepEqual(one({note:'signed',visit_id:'v'},'note','completed'),[['Note signed','green']]);
 assert.deepEqual(one({note:'in_progress',visit_id:'v'},'note','completed'),[['Note in progress','amber']]);
 assert.deepEqual(one({note:'not_started',visit_id:'v'},'note','completed'),[['Note not started','amber']]);
 assert.deepEqual(one({note:null},'note','completed'),[['Note not started','amber']]);
 assert.deepEqual(one({note:'in_progress',visit_id:'v'},'note','in_progress'),[['Note in progress','grey']]);
 assert.deepEqual(one({note:'in_progress',visit_id:'v'},'note','booked'),[],'no note marker before the visit starts');
 assert.deepEqual(one({charges:'posted',visit_id:'v'},'charges','completed'),[['Charges posted','green']]);
 assert.deepEqual(one({charges:'draft',visit_id:'v'},'charges','completed'),[['Charges draft','amber']]);
 assert.deepEqual(one({charges:'none',visit_id:'v'},'charges','completed'),[['No charges','amber']]);
 assert.deepEqual(one({charges:'none',visit_id:'v'},'charges','in_progress'),[],'a visit still under way is not nagged about charges');
 for(const marker of markersFor({new_patient:true,forms:{status:'submitted',packet_id:'k'},insurance:{status:'not_active',coverage_id:'c'},copay:{due_cents:1500,paid_cents:0,test_paid_cents:0},balance_cents:4500,note:'in_progress',charges:'draft',visit_id:'v'},'completed'))assert(marker.tip.length>10&&marker.label,`${marker.kind} has a tooltip and a text label`);
 html=f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')");
 assert.equal((html.match(/<svg class="marker-icon"/g)||[]).length,(html.match(/class="appt-marker /g)||[]).length,'each marker is an icon and a label');
 assert.equal((html.match(/data-marker-appointment="a"/g)||[]).length,7,'each marker is a button that leads somewhere');
 // Markers not yet loaded: no markers and no misleading offer.
 f.run("scheduleMarkerState={key:'k',items:new Map(),loaded:false,failed:false}");assert.equal(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')"),'');
 // Week and month cards keep the status and the two most urgent markers.
 const busy={new_patient:true,forms:{status:'submitted',packet_id:'k'},insurance:{status:'not_active',coverage_id:'c'},copay:{due_cents:1500,paid_cents:0,test_paid_cents:0},balance_cents:4500};
 assert.deepEqual(markersFor(busy,'booked','week').map(m=>m.label),['Not active','$15 due']);
 assert.deepEqual(markersFor(busy,'booked','compact').map(m=>m.label),['Not active','$15 due']);
 assert.deepEqual(markersFor({forms:{status:'reviewed',packet_id:'k'},insurance:{status:'active',coverage_id:'c'},copay:{due_cents:1500,paid_cents:1500,test_paid_cents:0}},'booked','week'),[],'nothing urgent, nothing shown');
 assert.equal(markersFor(busy,'booked','day').length,5,'the day view shows everything');

 // ---- A role without billing access ----
 f.load([appointment('a','09:00','09:30',{status:'completed'})],[{appointment_id:'a',patient_id:'patient-a',new_patient:true,visit_id:'v',forms:{status:'submitted',packet_id:'k'},note:'in_progress'}]);
 assert.deepEqual(markerLabels(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')")).map(m=>m.kind),['new','forms','note'],'no insurance, copay, balance or charges markers without billing facts');
 html=f.run('schedulePanelFacts(scheduleState.appointments[0])');assert.match(html,/Intake form/);assert.match(html,/Visit note/);assert.doesNotMatch(html,/Insurance|Copay|Balance|Charges|collect-copay|check-eligibility/);
 assert.doesNotMatch(f.run('scheduleSummaryHtml()'),/insurance not checked/);

 // ---- Summary counts double as filters ----
 f.load([appointment('a','08:00','08:30',{status:'completed'}),appointment('b','09:00','09:30',{status:'checked_in'}),appointment('c','09:30','10:00',{status:'checked_in'}),appointment('d','10:00','10:30',{status:'in_progress'}),appointment('e','11:00','11:30'),appointment('f','11:30','12:00'),appointment('g','13:00','13:30',{status:'cancelled'}),appointment('h','14:00','14:30',{status:'no_show'})],
  [{...base,appointment_id:'b',forms:{status:'submitted',packet_id:'kb'}},{...base,appointment_id:'c',forms:{status:'submitted',packet_id:'kc'}},{...base,appointment_id:'e',forms:{status:'submitted',packet_id:'ke'},insurance:{status:'not_checked',coverage_id:'ce'}},{...base,appointment_id:'f',insurance:{status:'not_checked',coverage_id:'cf'}},{...base,appointment_id:'g',forms:{status:'submitted',packet_id:'kg'},insurance:{status:'not_checked',coverage_id:'cg'}},{...base,appointment_id:'a',insurance:{status:'not_checked',coverage_id:'ca'}}]);
 f.run("scheduleMode='day';scheduleFilter='all'");
 const summary=()=>f.run('scheduleSummaryHtml()').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
 assert.match(summary(),/6 appointments · 2 checked in · 1 in progress · 3 forms to review · 2 insurance not checked/,'cancelled and no-show visits are not counted; nor are their forms or insurance');
 assert.match(summary(),/Scheduled 2 In office 3 Finished 1/);
 const shown=()=>[...f.run('scheduleDayCalendar()').matchAll(/data-schedule-open="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(shown().length,8,'everything is shown until a count is chosen');
 for(const [key,ids] of [['checked_in',['b','c']],['in_progress',['d']],['forms_review',['b','c','e']],['insurance_unchecked',['e','f']],['scheduled',['e','f']],['in_office',['b','c','d']],['finished',['a']]]){
  f.run('renderSchedule()');await f.click({scheduleFilter:key});
  assert.equal(f.run('scheduleFilter'),key);assert.deepEqual(shown(),ids,`the ${key} count shows only those visits`);
  assert.match(f.node('schedule-head').innerHTML,new RegExp(`data-schedule-filter="${key}"[^>]*aria-pressed="true"`));assert.match(f.node('schedule-head').innerHTML,/Show all/);
  await f.click({scheduleFilter:key});assert.equal(f.run('scheduleFilter'),'all','choosing the same count again shows everything');
 }
 assert.equal(f.calls.filter(call=>call[0]==='api').length,0,'filtering reads nothing from the server');
 f.load([appointment('a','09:00','09:30')],[]);assert.match(summary(),/ 1 appointment · 0 checked in · 0 in progress$/,'counts that are zero for forms and insurance are left out');
 html=f.run('scheduleHeadHtml()');
 assert.match(html,/<details class="schedule-more"><summary>More<\/summary><div class="schedule-more-menu"><button type="button" data-previsit-refresh>Intake readiness<\/button><button type="button" data-series-list>Recurring series<\/button><button type="button" data-reminder-workspace>Reminders<\/button><\/div><\/details><button type="button" data-new-block>Block time<\/button><button type="button" class="primary" data-new-appointment>\+ Appointment<\/button>/,'secondary tools are under More; Block time and + Appointment stay out');
 assert.match(html,/data-schedule-shift="-1"[^>]*>←<\/button><button type="button" data-schedule-today>Today<\/button><button type="button" data-schedule-shift="1"/);assert.match(html,/name="date" type="date" value="2030-11-15"/);
 assert.deepEqual([...html.matchAll(/data-schedule-view="([a-z_]+)"[^>]*aria-pressed="(true|false)">([A-Za-z]+)</g)].map(m=>m.slice(1)),[['day','true','Day'],['week_grid','false','Week'],['month','false','Month'],['week','false','List']],'day, week, month and list views all stay available');
 assert.match(html,/Friday, November 15, 2030/);assert.doesNotMatch(html,/entries|Updates automatically|Select a patient to manage|America\/Chicago|Month calendar|agenda/i);
 f.c.me.role='read_only';html=f.run('scheduleHeadHtml()');assert.doesNotMatch(html,/data-new-block|data-new-appointment/);f.c.me.role='owner';
 // Choosing a view is remembered; opening a day from the month is not.
 await f.click({scheduleView:'week_grid'});assert.equal(f.run('scheduleMode'),'week_grid');assert.equal(f.store.get('suncharts.schedule.default-view.tenant.p1'),'week_grid');
 await f.click({scheduleView:'sideways'});assert.equal(f.run('scheduleMode'),'week_grid');
 await f.click({calendarDay:'2030-11-22'});assert.deepEqual(plain(f.run('[scheduleMode,scheduleDate]')),['day','2030-11-22']);assert.equal(f.store.get('suncharts.schedule.default-view.tenant.p1'),'week_grid');
 await f.click({scheduleZoom:'compact'});assert.equal(f.store.get('suncharts.schedule.default-view.tenant.p1.zoom'),'compact');assert.match(f.run('scheduleDayCalendar()'),/zoom-compact/);
 f.run(`scheduleDate='${DAY}';scheduleMode='day';scheduleZoom='comfortable'`);

 // ---- Month: three compact cards, then "+N more" ----
 f.load([appointment('a','08:00','08:30'),appointment('b','09:00','09:30'),appointment('c','10:00','10:30'),appointment('d','11:00','11:30'),appointment('e','13:00','13:30'),appointment('x','09:00','09:30',{starts_at:at('09:00','2030-11-19'),ends_at:at('09:30','2030-11-19')})],[{...base,appointment_id:'a',...busy}]);
 f.run("scheduleMode='month'");html=f.run('scheduleMonthCalendar()');
 const cell=html.split('<td ').find(part=>part.includes('data-calendar-day="2030-11-15"'));
 assert.equal((cell.match(/class="appt-card appt-compact /g)||[]).length,3);assert.match(cell,/<button type="button" class="calendar-more" data-calendar-day="2030-11-15"[^>]*>\+2 more<\/button>/);
 assert.match(cell,/aria-label="Open Friday, November 15, 2030, 5 appointments"/);assert.deepEqual(markerLabels(cell).map(m=>m.label),['Not active','$15 due']);
 const single=html.split('<td ').find(part=>part.includes('data-calendar-day="2030-11-19"'));assert.equal((single.match(/class="appt-card /g)||[]).length,1);assert.doesNotMatch(single,/calendar-more/);
 const empty=html.split('<td ').find(part=>part.includes('data-calendar-day="2030-11-20"'));assert.doesNotMatch(empty,/entries|appt-card|calendar-more/);assert.match(empty,/aria-label="Open Wednesday, November 20, 2030"/);
 f.run('renderSchedule()');await f.click({calendarDay:'2030-11-15'});assert.deepEqual(plain(f.run('[scheduleMode,scheduleDate]')),['day',DAY],'"+N more" opens that day');
 // The list view uses the same card.
 f.run("scheduleMode='week'");html=f.run('scheduleListView()');assert.equal((html.match(/class="appt-card appt-row /g)||[]).length,6);assert.match(html,/No appointments/);assert.doesNotMatch(html,/entries/);
 f.run("scheduleMode='day'");

 // ---- Names are escaped everywhere ----
 const hostile=appointment('a','09:00','09:30',{patient_name:'<img src=x onerror=alert(1)>, "Pat"',provider_label:'<script>alert(2)</script>',clinician_id:'unknown',title:'<b>Visit</b>',facility:'<i>Clinic</i>',room:'"1"',notes:'<u>note</u>'});
 f.load([hostile,appointment('b','10:00','10:30',{clinician_id:'p2'})],[{...base,...busy}],[{id:'block',clinician_id:'unknown',starts_at:at('12:00'),ends_at:at('13:00'),label:'<svg onload=alert(3)>',version:1}]);
 f.run("scheduleProviders=[{id:'p2',label:'<em>Dr</em> & Co'}]");
 for(const view of ['scheduleDayCalendar()','scheduleWeekCalendar()','scheduleMonthCalendar()','scheduleListView()','scheduleHeadHtml()',"schedulePanelHtml(scheduleState.appointments[0],scheduleState.appointments[0].patient_name,[{snapshot:{status:'booked',starts_at:scheduleState.appointments[0].starts_at,ends_at:scheduleState.appointments[0].ends_at,title:'<b>Visit</b>',facility:'<i>Clinic</i>',room:'x'},reason:'<script>r</script>',created_at:scheduleState.appointments[0].starts_at}])"]){
  html=f.run(view);assert.doesNotMatch(html,/<img|<script|<b>Visit|<i>|<u>|<em>|<svg onload|onerror=alert\(1\)>/,`${view} escapes names`);
 }
 assert.match(f.run('scheduleDayCalendar()'),/&lt;img src=x onerror=alert\(1\)&gt;, &quot;Pat&quot;/);assert.match(f.run('scheduleDayCalendar()'),/&lt;em&gt;Dr&lt;\/em&gt; &amp; Co/);
 f.run("scheduleProviders=[{id:'p1',label:'Dr. Dana Owner'},{id:'p2',label:'Dr. Sam Rivera'}]");

 // ---- Panel actions by status and role, each through the existing route or flow ----
 const facts={...base,insurance:{status:'not_checked',coverage_id:'coverage-a'},copay:{due_cents:1500,paid_cents:0,test_paid_cents:0},balance_cents:4500};
 const actions=(status,role='owner',extra={},mine=true)=>{f.c.me={role,user_id:mine?'p1':'someone',tenant_id:'tenant'};f.load([appointment('a','09:00','09:30',{status})],[{...facts,...extra}]);const panel=f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])");return [...panel.matchAll(/data-board-action="([a-z-]+)"|data-(schedule-start|schedule-edit|schedule-chart|schedule-pick-move)=|<option value="(cancel|no_show)"/g)].map(m=>m[1]||m[2]||m[3]);};
 assert.deepEqual(actions('booked'),['check-in','schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','schedule-edit','schedule-pick-move','cancel']);
 f.load([appointment('past','09:00','09:30',{starts_at:'2020-01-06T15:00:00Z',ends_at:'2020-01-06T15:30:00Z'})],[]);
 assert.match(f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, past',[])"),/<option value="cancel">Cancel appointment<\/option><option value="no_show">Patient did not show up<\/option>/,'a no-show can be recorded once the time has passed');
 assert.deepEqual(actions('checked_in'),['schedule-start','schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','cancel']);
 assert.deepEqual(actions('checked_in','owner',{},false),['schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','cancel'],'another clinician’s visit is not started from here');
 assert.deepEqual(actions('in_progress','owner',{visit_id:'v',note:'in_progress',charges:'draft'}),['visit','schedule-chart','check-eligibility','insurance','collect-copay','billing','visit','charges']);
 assert.deepEqual(actions('completed','owner',{visit_id:'v',note:'signed',charges:'posted',copay:{due_cents:1500,paid_cents:1500,test_paid_cents:0},forms:{status:'reviewed',packet_id:'k'}}),['visit','schedule-chart','review-intake','check-eligibility','insurance','collect-copay','billing','visit','charges']);
 assert.deepEqual(actions('cancelled'),['schedule-chart','billing'],'a cancelled visit offers nothing to do but look');
 assert.deepEqual(actions('no_show'),['schedule-chart','billing']);
 assert.deepEqual(markersFor({new_patient:true,forms:{status:'submitted',packet_id:'k'},insurance:{status:'not_checked',coverage_id:'c'},copay:{due_cents:1500,paid_cents:0,test_paid_cents:0},balance_cents:4500},'cancelled').map(m=>m.label),['Owes $45'],'a cancelled visit carries no to-do markers');
 assert.deepEqual(markersFor({copay:{due_cents:1500,paid_cents:1500,test_paid_cents:0}},'no_show').map(m=>m.label),['Copay paid'],'money already taken stays visible');
 assert.deepEqual(actions('booked','front_desk'),['check-in','schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','schedule-edit','schedule-pick-move','cancel']);
 assert.deepEqual(actions('checked_in','front_desk'),['schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','cancel'],'the front desk does not start visits');
 assert.deepEqual(actions('checked_in','nurse'),['schedule-start','schedule-chart','insurance','billing'],'rooming staff start the visit but do not send forms, take payment or cancel');
 assert.deepEqual(actions('booked','read_only'),['schedule-chart','insurance','billing'],'a read-only role can only look');
 assert.deepEqual(actions('booked','owner',{forms:{status:'submitted',packet_id:'k'}}).slice(0,3),['check-in','schedule-chart','review-intake']);
 f.c.me={role:'owner',user_id:'p1',tenant_id:'tenant'};
 const limited=fixture({denied:['billing']});limited.load([appointment('a','09:00','09:30',{status:'booked'})],[facts]);
 assert.doesNotMatch(limited.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])"),/collect-copay|check-eligibility/,'no payment or eligibility actions without billing access');
 // Each action reaches the route or flow that already exists.
 const act=async(action,status,extra={},replies={})=>{const g=fixture({replies});g.load([appointment('a','09:00','09:30',{status})],[{...facts,...extra}]);g.run("showSchedule=async()=>{calls.push(['reload']);};appointmentDetail=async id=>{calls.push(['detail',id]);}");await g.click({boardAction:action,appointment:'a'});return g;};
 let g=await act('check-in','booked');
 assert.deepEqual(plain(g.calls.filter(call=>call[0]==='api').map(call=>call.slice(1,3))),[['/api/v1/appointments/a/check-in','POST']]);assert.deepEqual(plain(g.calls.slice(-3)),[['reload'],['detail','a'],['notice','Patient checked in.',false]]);
 g=await act('check-in','checked_in');await assert.rejects(g.c.pending,/Only a booked appointment/);assert.equal(g.calls.filter(call=>call[0]==='api').length,0);
 g=await act('send-intake','booked',{},{'/intake-forms':{method:'POST',value:{packet_id:'packet',intake_url:'/intake?token=synthetic',expires_at:'2030-12-15T00:00:00Z',replaced:0,practice_name:'Synthetic Clinic'}}});
 assert.deepEqual(plain(g.calls.find(call=>call[0]==='api').slice(1,4)),['/api/v1/patients/patient-a/intake-forms','POST',{appointment_id:'a'}]);
 assert.match(g.run("schedulePanelLink(scheduleState.appointments[0])"),/value="http:\/\/localhost:8099\/intake\?token=synthetic"/);assert.match(g.calls.at(-1)[1],/link is ready/);
 g.c.me={role:'nurse',user_id:'n',tenant_id:'tenant'};await g.click({boardAction:'send-intake',appointment:'a'});await assert.rejects(g.c.pending,/cannot send intake forms/);
 g=await act('check-eligibility','booked',{},{'/claimmd-eligibility/check':{method:'POST',value:{outcome:'checked'}}});
 let sent=g.calls.find(call=>call[0]==='api');assert.equal(sent[1],'/api/v1/patients/patient-a/coverages/coverage-a/claimmd-eligibility/check');assert.equal(sent[2],'POST');assert.equal(sent[3].automatic,false);assert.equal(sent[3].appointment_id,'a');assert.match(sent[3].request_id,/^request-/);
 assert(g.calls.some(call=>call[0]==='reload'),'the markers are read again after a check');
 g=await act('check-eligibility','booked',{},{'/claimmd-eligibility/check':{method:'POST',value:{outcome:'needs',needs:[{kind:'payer_id'}]}}});
 assert.deepEqual(plain(g.calls.filter(call=>['clinical','select','section'].includes(call[0]))),[['clinical'],['select','patient-a',null],['section','insurance']],'a check that needs an answer continues in the chart’s insurance step');
 assert.equal(g.c.insuranceAppointmentSelection.get('patient-a'),'a');
 g=await act('check-eligibility','booked',{insurance:{status:'self_pay'}});await assert.rejects(g.c.pending,/no active insurance/);assert.equal(g.calls.filter(call=>call[0]==='api').length,0);
 g=await act('collect-copay','checked_in');
 assert.deepEqual(plain(g.calls.filter(call=>call[0]!=='notice')),[['clinical'],['select','patient-a',null],['section','insurance']]);assert.equal(g.c.insuranceAppointmentSelection.get('patient-a'),'a','the copay step opens for this appointment');
 g=await act('billing','booked');assert.deepEqual(plain(g.calls.at(-1)),['section','billing']);
 g=await act('visit','in_progress',{visit_id:'visit-a'});assert.deepEqual(plain(g.calls),[['clinical'],['select','patient-a','visit-a']]);
 g=await act('charges','completed',{visit_id:'visit-a'});assert.deepEqual(plain(g.calls),[['clinical'],['select','patient-a','visit-a'],['encounter','charges']]);
 g=await act('visit','in_progress');await assert.rejects(g.c.pending,/No visit has been started/);
 g=await act('review-intake','checked_in',{forms:{status:'submitted',packet_id:'packet-a'}});assert.deepEqual(plain(g.calls),[['intake','packet-a']]);
 // Start visit keeps the schedule's existing handler.
 g=fixture({replies:{'/api/v1/visits':{method:'POST',value:{id:'new-visit'}}}});g.load([appointment('a','09:00','09:30',{status:'checked_in'})],[facts]);await g.click({scheduleStart:'a',patient:'patient-a'});
 assert.deepEqual(plain(g.calls).map(row=>row.slice(0,4)),[['api','/api/v1/visits','POST',{appointment_id:'a'}],['clinical'],['select','patient-a','new-visit']]);
 // Reschedule and cancel stay on the existing editor and action form.
 html=actions('booked')&&f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])");assert.match(html,/<form id="schedule-action" data-id="a" data-version="1">/);assert.match(html,/data-schedule-edit="a">Reschedule or edit/);
 // Markers lead to the place that deals with them.
 const marker=async(kind,status,extra)=>{const h=fixture();h.load([appointment('a','09:00','09:30',{status})],[{...facts,...extra}]);h.run("appointmentDetail=async id=>{calls.push(['detail',id]);}");await h.click({marker:kind,markerAppointment:'a'});return plain(h.calls);};
 assert.deepEqual(await marker('forms','booked',{forms:{status:'submitted',packet_id:'packet-a'}}),[['intake','packet-a']]);
 assert.deepEqual(await marker('forms','booked',{forms:{status:'sent',packet_id:'packet-a'}}),[['detail','a']]);
 assert.deepEqual(await marker('insurance','booked'),[['detail','a']]);
 assert.deepEqual((await marker('copay','booked')).at(-1),['section','insurance']);
 assert.deepEqual((await marker('balance','booked')).at(-1),['section','billing']);
 assert.deepEqual(await marker('note','completed',{visit_id:'visit-a',note:'in_progress'}),[['clinical'],['select','patient-a','visit-a']]);
 assert.deepEqual((await marker('charges','completed',{visit_id:'visit-a',charges:'draft'})).at(-1),['encounter','charges']);
 assert.deepEqual(await marker('new','booked',{new_patient:true}),[['detail','a']]);

 // ---- Check insurance for the day: one at a time, on the server's terms ----
 const dayFacts=[{...base,appointment_id:'a',insurance:{status:'not_checked',coverage_id:'c1'}},{...base,appointment_id:'b',insurance:{status:'not_checked',coverage_id:'c2'}},{...base,appointment_id:'c',insurance:{status:'not_checked',coverage_id:'c3'}},{...base,appointment_id:'d',insurance:{status:'not_checked',coverage_id:'c1'}},{...base,appointment_id:'e',insurance:{status:'active',coverage_id:'c5'}},{...base,appointment_id:'g',insurance:{status:'not_checked',coverage_id:'c6'}}];
 const dayVisits=[appointment('a','08:00','08:30'),appointment('b','09:00','09:30'),appointment('c','10:00','10:30'),appointment('d','11:00','11:30',{patient_id:'patient-a'}),appointment('e','12:00','12:30'),appointment('g','13:00','13:30',{status:'cancelled'})];
 let inFlight=0,most=0;const answers={c1:{outcome:'checked'},c2:{outcome:'checked'},c3:{outcome:'needs'}};
 g=fixture({replies:{'/claimmd-eligibility/check':{method:'POST',value:async route=>{inFlight++;most=Math.max(most,inFlight);await new Promise(resolve=>setImmediate(resolve));inFlight--;return answers[route.split('/coverages/')[1].split('/')[0]];}}}});
 g.load(dayVisits,dayFacts);g.run("scheduleMode='day'");
 assert.match(g.run('scheduleSummaryHtml()'),/data-board-action="check-day-insurance">Check insurance for this day</);
 g.c.fixtureAppointments=dayVisits;g.c.fixtureMarkers=dayFacts.map(m=>m.appointment_id==='a'||m.appointment_id==='d'?{...m,insurance:{status:'active',coverage_id:'c1'}}:m.appointment_id==='b'?{...m,insurance:{status:'not_active',coverage_id:'c2'}}:m);
 await g.click({boardAction:'check-day-insurance'});await new Promise(resolve=>setImmediate(resolve));
 const checks=g.calls.filter(call=>call[0]==='api'&&call[2]==='POST');
 assert.deepEqual(checks.map(call=>call[1].split('/coverages/')[1].split('/')[0]),['c1','c2','c3'],'each coverage is asked once; checked, cancelled and finished visits are skipped');
 assert(checks.every(call=>call[3].automatic===true&&call[3].appointment_id),'the server applies its own freshness rules and request limit');assert.equal(most,1,'one request at a time');
 assert.equal(g.run('scheduleBatchMessage'),'2 checked · 1 not active · 1 could not be checked');assert.match(g.calls.at(-1)[1],/2 checked · 1 not active · 1 could not be checked/);
 g=fixture({replies:{'/claimmd-eligibility/check':{method:'POST',value:{outcome:'skipped',reason:'rate_limited'}}}});g.load(dayVisits,dayFacts);g.c.fixtureAppointments=dayVisits;g.c.fixtureMarkers=dayFacts;
 await g.click({boardAction:'check-day-insurance'});
 assert.equal(g.calls.filter(call=>call[0]==='api'&&call[2]==='POST').length,1,'it stops asking once the request limit is reached');assert.match(g.run('scheduleBatchMessage'),/0 checked · 0 not active · 3 could not be checked \(the insurer request limit/);
 g.c.me.role='clinician';assert.doesNotMatch(g.run('scheduleSummaryHtml()'),/check-day-insurance/,'offered to the owner and the front desk');
 g.c.me.role='front_desk';assert.match(g.run('scheduleSummaryHtml()'),/check-day-insurance/);g.run("scheduleMode='month'");assert.doesNotMatch(g.run('scheduleSummaryHtml()'),/check-day-insurance|Scheduled/,'a day-view tool');

 // ---- Clicking an empty time books there with that provider ----
 g=fixture();g.load([appointment('a','09:00','09:30')],[]);g.run("appointmentEditor=async(...args)=>{calls.push(['book',...args]);};reviewScheduleMove=async(...args)=>{calls.push(['move',...args]);}");
 const column={dataset:{gridDay:DAY,gridProvider:'p2'},closest:selector=>selector==='.schedule-grid'?{dataset:{first:'420'}}:null};
 const gridClick=g.listeners.get('click').filter(l=>!l.capture)[1].callback,target={closest:selector=>selector==='[data-grid-column]'?column:null,hasAttribute:()=>false};
 column.closest=selector=>selector==='.schedule-grid'?{dataset:{first:'420'}}:null;
 const emptySpot=Object.assign(column,{hasAttribute:()=>false});emptySpot.closest=selector=>selector==='[data-grid-column]'?column:selector==='.schedule-grid'?{dataset:{first:'420'}}:null;
 gridClick({target:emptySpot,offsetY:(13*60+40-420)*2});await g.c.pending;
 assert.deepEqual(plain(g.calls.at(-1)),['book',null,null,null,DAY,`${DAY}T13:30`,'p2']);
 gridClick({target:{closest:selector=>selector==='[data-grid-column]'?column:null,hasAttribute:()=>false},offsetY:10});assert.equal(g.calls.length,1,'a click on a card or block is not a click on empty time');
 g.run("scheduleDrag={id:'a',version:1,provider:'p1'}");gridClick({target:emptySpot,offsetY:(15*60-420)*2});await g.c.pending;
 assert.deepEqual(plain(g.calls.at(-1)),['move','a',`${DAY}T15:00`,'p2',1],'with a move in hand, the click reviews the move');
 g.c.me.role='read_only';gridClick({target:emptySpot,offsetY:100});assert.equal(g.calls.length,2,'a read-only role cannot book');

 // ---- Forty appointments ----
 const many=Array.from({length:40},(_,i)=>appointment('n'+i,`${String(8+Math.floor(i/4)).padStart(2,'0')}:${['00','15','30','45'][i%4]}`,`${String(8+Math.floor((i+2)/4)).padStart(2,'0')}:${['00','15','30','45'][(i+2)%4]}`,{clinician_id:i%2?'p1':'p2',status:['booked','checked_in','in_progress','completed'][i%4]}));
 g=fixture();g.load(many,many.map(a=>({...base,appointment_id:a.id,...busy,note:'in_progress',charges:'draft',visit_id:'v'})));
 const started=process.hrtime.bigint();for(let i=0;i<20;i++)g.run('renderSchedule()');const each=Number(process.hrtime.bigint()-started)/20e6;
 assert.equal((g.node('tools').innerHTML.match(/class="appt-card /g)||[]).length,40);assert(each<25,`a 40-appointment day renders in ${each.toFixed(1)}ms`);
 g.c.fixtureAppointments=many;await g.run('showSchedule()');assert.equal(g.calls.filter(call=>call[0]==='api').length,3,'a 40-appointment day is three reads: providers, appointments, markers');

 // ---- Keeping the page current without getting in the way ----
 g=fixture();g.c.fixtureAppointments=[appointment('a','09:00','09:30')];await g.run('showSchedule()');await g.run('scheduleMarkersReady');
 g.node('tools').hidden=false;g.calls.length=0;
 await g.run('refreshScheduleQuietly()');await g.run('scheduleMarkersReady');
 assert.deepEqual(g.calls.filter(call=>call[0]==='api').map(call=>call[1].split('?')[0]).sort(),['/api/v1/schedule','/api/v1/schedule/markers','/api/v1/schedule/providers'],'a refresh reads the schedule and its markers again');
 assert.equal(g.calls.some(call=>call[0]==='tool'),false,'a quiet refresh does not move the page');
 for(const busyWith of ["$('schedule-detail').hidden=false","$('tools').hidden=true","document.visibilityState='hidden'","scheduleDrag={id:'a'}","scheduleBatchMessage='Checking insurance… 1 of 2'"]){
  const h=fixture();h.c.fixtureAppointments=[appointment('a','09:00','09:30')];await h.run('showSchedule()');await h.run('scheduleMarkersReady');h.node('tools').hidden=false;h.calls.length=0;
  h.run(busyWith);await h.run('refreshScheduleQuietly()');assert.equal(h.calls.length,0,`nothing is redrawn while ${busyWith}`);
 }

 // ---- Styles: theme variables only ----
 const css=read('web/schedule-board.css').replace(/\/\*[\s\S]*?\*\//g,'');
 assert.doesNotMatch(css,/#[0-9a-fA-F]{3,8}\b/,'no hex colours');assert.doesNotMatch(css,/\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/,'no colour functions with literal values');
 for(const declaration of css.matchAll(/(?:^|[;{])\s*(color|background|background-color|border(?:-[a-z]+)?-color|border(?:-[a-z]+)?|outline|box-shadow|fill|stroke)\s*:\s*([^;}]+)/g)){
  const named=declaration[2].replace(/--[a-z-]+/g,'').match(/\b(?:white|black|red|green|blue|yellow|orange|purple|pink|grey|gray|silver|teal|navy|maroon|olive|aqua|lime|fuchsia)\b/);
  assert.equal(named,null,`${declaration[1]}: ${declaration[2]} uses a named colour`);
 }
 for(const variable of new Set([...css.matchAll(/var\((--[a-z-]+)/g)].map(m=>m[1]))){
  const defined=new RegExp(`${variable}\\s*:`).test(css)||new RegExp(`${variable}\\s*:`).test(read('web/theme.css'))||new RegExp(`${variable}\\s*:`).test(read('web/style.css'))||/^--(s|l|lane|lanes|minute|grid-minutes|grid-columns)$/.test(variable);
  assert(defined,`${variable} is a theme or board variable`);
 }
 for(const source of sources)assert.doesNotMatch(source.split('\n').filter(line=>/schedule(Card|GridHtml|MarkerHtml|HeadHtml|MonthCalendar|ListView|PanelHtml)/.test(line)).join('\n'),/style="/,'the content security policy forbids inline styles');
 const index=read('web/index.html');assert.match(index,/href="\/schedule-board\.css"/);assert(index.indexOf('src="/scheduling.js"')<index.indexOf('src="/schedule-board.js"'),'the board loads after the schedule it draws');
 console.log('PASS schedule board: day default and device memory, grid placement, provider columns, status wording, every marker and its absence, billing-free roles, panel actions by status and role, day insurance check, summary filters, month overflow, escaping, booking by time and theme-only colours');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
