// SPDX-License-Identifier: AGPL-3.0-only
// Schedule board: default view, time grid, appointment card, markers, panel actions,
// summary filters and month overflow. Synthetic fixtures only; no browser or server.
'use strict';
process.env.TZ='America/Chicago';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const sources=['web/display-format.js','web/scheduling.js','web/schedule-board.js'].map(read);
const plain=value=>JSON.parse(JSON.stringify(value));
// The application clock is fixed one day before the date used in the grid fixtures.
const TODAY='2030-11-14',DAY='2030-11-15',at=(time,day=DAY)=>new Date(`${day}T${time}:00-06:00`).toISOString();
const now=Date.parse(at('12:00',TODAY));
class ScheduleDate extends Date{
 constructor(...args){super(...(args.length?args:[now]));}
 static now(){return now;}
}
const appointment=(id,start,end,extra={})=>({id,version:1,patient_id:'patient-'+id,clinician_id:'p1',starts_at:at(start),ends_at:at(end),status:'booked',title:'Office visit',category:'Office visit',facility:'',room:'',notes:'',patient_name:'Example, '+id,provider_label:'owner@example.test',...extra});
const todayAppointment=(id,start,end)=>appointment(id,start,end,{starts_at:at(start,TODAY),ends_at:at(end,TODAY)});

function createFixture(options={}){
 const nodes=new Map(),listeners=new Map(),calls=[],store=options.store||new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',hidden:true,dataset:{},classList:{add(){},remove(){},toggle(){}},closest(){return this;},querySelector(){return null;},contains(){return false;}});return nodes.get(id);};
 const replies=options.replies||{};
 const mount=name=>{node('tools').hidden=false;node('page-title').textContent=name;};
 const c=vm.createContext({Date:options.clock||Date,Intl,URLSearchParams,console,Map,Set,JSON,Math,Number,String,Array,Object,Promise,Error,
  crypto:{randomUUID:()=>`request-${calls.length}`},location:{origin:'http://localhost:8099'},
  localStorage:options.brokenStorage?{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}}:{getItem:key=>store.has(key)?store.get(key):null,setItem:(key,value)=>{store.set(key,String(value));}},
  document:{getElementById:node,addEventListener(type,callback,capture){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({callback,capture});},visibilityState:'visible',activeElement:null},
  localTime:value=>{const d=new Date(value),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;},
  esc:value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
  date:value=>new Date(value).toISOString(),me:{role:'owner',user_id:'p1',tenant_id:'tenant'},$:id=>id==='appointment-copay-card'&&!nodes.has(id)?null:node(id),calls,
  showTool:name=>{mount(name);calls.push(['tool',name]);},notice:(message,error=false)=>calls.push(['notice',message,error]),
  run:work=>{c.pending=Promise.resolve().then(work);return c.pending;},
  showClinical:async()=>calls.push(['clinical']),selectPatient:async(id,visit)=>{calls.push(['select',id,visit]);c.selected=id;c.workspace={appointments:plain(vm.runInContext('scheduleState?scheduleState.appointments:[]',c))};if(visit)c.activeVisit={id:visit};},
  showChartSection:key=>calls.push(['section',key]),setEncounterSection:key=>calls.push(['encounter',key]),openWorkflowIntakePacket:async id=>calls.push(['intake',id]),
  insuranceAppointmentSelection:new Map(),copayAppointmentSelection:new Map(),openVisitCollect:()=>calls.push(['collect']),selected:undefined,workspace:undefined,activeVisit:undefined,
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
 const load=(appointments,markers=[],blocks=[])=>{mount('Schedule');c.fixtureAppointments=appointments;c.fixtureMarkers=markers;c.fixtureBlocks=blocks;c.given={appointments,blocks,markers};run("loadSchedulePreference();scheduleState={appointments:given.appointments,blocks:given.blocks};scheduleMarkerState={key:'k',items:new Map(given.markers.map(m=>[m.appointment_id,m])),loaded:true,failed:false}");};
 const click=async dataset=>{const button={dataset,type:'button',textContent:'',hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,x)=>x.toUpperCase())),closest:selector=>selector==='button'?button:selector.split(',').includes('#schedule-workspace')?node('schedule-workspace'):null};for(const listener of listeners.get('click'))if(!listener.capture)listener.callback({target:{closest:selector=>selector==='button'?button:null,hasAttribute:()=>false},preventDefault(){}});await c.pending?.catch(()=>{});};
 return {c,run,node,listeners,calls,store,load,click};
}
const markerLabels=html=>[...html.matchAll(/class="appt-marker tone-([a-z]+)" data-marker="([a-z]+)"[^>]*title="([^"]*)">.*?<span>([^<]*)<\/span>/g)].map(m=>({tone:m[1],kind:m[2],tip:m[3],label:m[4]}));

async function main(){
 const fixture=options=>createFixture({...options,clock:ScheduleDate});
 // ---- Default view and what is remembered on this device ----
 let f=fixture();
 await f.run('showSchedule()');
 assert.deepEqual(plain(f.run('[scheduleMode,scheduleDate]')),['month',TODAY],'entering Schedule opens this month');
 await f.click({scheduleView:'week_grid'});
 assert.equal(f.run('scheduleMode'),'week_grid');
 assert.equal(f.store.get('suncharts.schedule.default-view.tenant.p1.chosen-view'),'week_grid');
 await f.click({calendarDay:DAY});
 assert.equal(f.run('scheduleMode'),'day');
 const change=(fixture,key,value,checked)=>{
  for(const listener of fixture.listeners.get('change'))listener.callback({target:{dataset:{[key]:value},checked}});
 };
 change(f,'scheduleProvider','p2',false);
 change(f,'scheduleLocation','North',false);
 await f.click({scheduleFilter:'scheduled'});
 f.node('page-title').textContent='Patients';
 await f.run('showSchedule()');
 assert.deepEqual(plain(f.run('[scheduleMode,scheduleDate]')),['week_grid',TODAY],'re-entry restores the explicit view and resets the date');
 assert.equal(f.run("scheduleProviderVisible('p2')"),false);
 assert.equal(f.run("scheduleProviderVisible('p3')"),true,'new providers are shown');
 assert.equal(f.run("scheduleLocationEnabled('South')"),true,'new locations are shown');
 assert.equal(f.run("scheduleLocationEnabled('North')"),false,'a saved location exclusion survives a range without that location');
 const filtersReload=fixture({store:new Map(f.store)});await filtersReload.run('showSchedule()');
 assert(!filtersReload.run("scheduleProviderVisible('p2')||scheduleLocationEnabled('North')"),'filters survive reload');
 assert.equal(filtersReload.run('scheduleFilter'),'scheduled');
 await filtersReload.click({scheduleView:'month'});
 assert.equal(filtersReload.run('scheduleFilter'),'scheduled','a compatible status filter carries across views');
 await filtersReload.click({scheduleFilter:'all'});
 change(filtersReload,'scheduleProvider','p2',true);
 change(filtersReload,'scheduleLocation','North',true);
 const cleared=fixture({store:filtersReload.store});await cleared.run('showSchedule()');
 assert(cleared.run("scheduleProviderVisible('p2')&&scheduleLocationEnabled('North')"),'re-checking clears the saved choices');
 assert.equal(cleared.run('scheduleFilter'),'all','Show all clears the saved status filter');
 f.run("scheduleProvider='11111111-1111-4111-8111-111111111111';saveSchedulePreference('provider');scheduleZoom='compact';saveSchedulePreference('zoom')");
 assert.deepEqual([...f.store.keys()].sort(),['suncharts.schedule.default-view.tenant.p1.chosen-view','suncharts.schedule.default-view.tenant.p1.hidden-locations','suncharts.schedule.default-view.tenant.p1.hidden-providers','suncharts.schedule.default-view.tenant.p1.provider','suncharts.schedule.default-view.tenant.p1.status-filter','suncharts.schedule.default-view.tenant.p1.zoom']);
 const again=fixture({store:f.store});again.c.fixtureProviders.push({id:'11111111-1111-4111-8111-111111111111',label:'Synthetic Provider'});await again.run('showSchedule()');
 assert.deepEqual(plain(again.run('[scheduleMode,scheduleDate,scheduleProvider,scheduleZoom]')),['week_grid',TODAY,'11111111-1111-4111-8111-111111111111','compact'],'reload restores the saved view and legacy provider and density');
 await again.run("showSchedule({entry:true,date:'2030-12-19',view:'day',unfiltered:true})");
 assert.deepEqual(plain(again.run('[scheduleMode,scheduleDate,scheduleUnfiltered]')),['day','2030-12-19',true]);
 assert(again.run("scheduleProviderVisible('p2')&&scheduleLocationEnabled('North')"));
 assert.equal(again.run('scheduleFilter'),'all');
 await again.run('showSchedule({entry:true})');
 assert.deepEqual(plain(again.run('[scheduleMode,scheduleDate,scheduleUnfiltered]')),['week_grid',TODAY,false]);
 assert(!again.run("scheduleProviderVisible('p2')||scheduleLocationEnabled('North')"));
 assert.equal(again.run('scheduleFilter'),'scheduled');
 again.c.me={role:'front_desk',user_id:'someone-else',tenant_id:'tenant'};again.run('loadSchedulePreference()');
 assert.deepEqual(plain(again.run('[scheduleMode,scheduleProvider,scheduleZoom]')),['month','','comfortable'],'another person on the device starts from the default');
 assert(again.run("scheduleProviderVisible('p2')&&scheduleLocationEnabled('North')"));
 again.c.me={role:'owner',user_id:'p1',tenant_id:'other-tenant'};again.run('loadSchedulePreference()');
 assert.deepEqual(plain(again.run('[scheduleMode,scheduleProvider,scheduleZoom]')),['month','','comfortable'],'the same person starts from the default at another practice');
 const junk=fixture({store:new Map([['suncharts.schedule.default-view.tenant.p1.chosen-view','sideways'],['suncharts.schedule.default-view.tenant.p1.provider','<script>'],['suncharts.schedule.default-view.tenant.p1.hidden-locations','bad']])});junk.run('loadSchedulePreference()');
 assert.deepEqual(plain(junk.run('[scheduleMode,scheduleProvider,scheduleHiddenLocations.size]')),['month','',0],'a damaged saved choice is ignored');
 const blocked=fixture({brokenStorage:true});blocked.run("loadSchedulePreference();scheduleMode='week';saveSchedulePreference()");
 await blocked.run('showSchedule({entry:true})');
 assert.equal(blocked.run('scheduleMode'),'week','blocked storage preserves choices while the same session is open');
 const previousUser=blocked.c.me;
 blocked.run('clearScheduleSession()');blocked.c.me=undefined;
 assert.equal(blocked.run('scheduleState'),undefined);
 blocked.c.me={...previousUser};await blocked.run('showSchedule({entry:true})');
 assert.equal(blocked.run('scheduleMode'),'month','an in-memory choice does not survive sign-out');
 let resolveSignOutRead;
 const signOutRead=new Promise(resolve=>{resolveSignOutRead=resolve;});
 const signOut=fixture({replies:{'/schedule?':{value:()=>signOutRead}}});
 const pendingBoard=signOut.run('showSchedule()');
 signOut.run('clearScheduleSession()');signOut.c.me=undefined;
 resolveSignOutRead({appointments:[todayAppointment('a','09:00','09:30')],blocks:[]});
 await pendingBoard;
 assert.equal(signOut.run('scheduleState'),undefined,'a response arriving after sign-out cannot repopulate the board');
 assert.equal(signOut.calls.some(call=>call[0]==='tool'),false);
 // A remembered provider who has left the practice is forgotten.
 const gone=fixture({store:new Map([['suncharts.schedule.default-view.tenant.p1.provider','99999999-9999-4999-8999-999999999999']])});
 gone.c.fixtureAppointments=[todayAppointment('a','09:00','09:30')];await gone.run('showSchedule()');
 assert.equal(gone.run('scheduleProvider'),'');assert.equal(gone.store.get('suncharts.schedule.default-view.tenant.p1.provider'),'');
 assert.equal(gone.calls.filter(call=>call[0]==='api'&&call[1].includes('/schedule?')).at(-1)[1].includes('clinician_id'),false);
 assert.match(gone.node('tools').innerHTML,/class="month-calendar"/);

 // ---- Cards first, markers from one read per visible range ----
 f=fixture();let releaseMarkers;const markerGate=new Promise(resolve=>{releaseMarkers=resolve;});
 f.c.fixtureAppointments=[todayAppointment('a','09:00','09:30'),todayAppointment('b','10:00','10:30')];
 const markerFacts=[{appointment_id:'a',patient_id:'patient-a',new_patient:true,visit_id:null,forms:null,insurance:{status:'not_checked',coverage_id:'coverage-a'},copay:null,balance_cents:0,charges:null,note:null}];
 const slow=fixture({replies:{'/schedule/markers?':{value:async()=>{await markerGate;return {items:markerFacts};}}}});
 slow.c.fixtureAppointments=f.c.fixtureAppointments;
 await slow.run("showSchedule({view:'day'})");
 let html=slow.node('tools').innerHTML;
 assert.equal((html.match(/class="appt-card /g)||[]).length,2,'cards are drawn before the markers arrive');assert.doesNotMatch(html,/class="appt-marker /);
 releaseMarkers();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.match(slow.node('schedule-body').innerHTML,/data-marker="insurance"/,'markers fill in afterwards');
 assert.equal(slow.calls.filter(call=>call[0]==='api'&&call[1].includes('/schedule/markers?')).length,1,'one marker read for the day, whatever the number of appointments');
 assert.equal(slow.calls.filter(call=>call[0]==='api'&&/appointments\/|patients\//.test(call[1])).length,0,'no per-appointment reads');
 // The same range keeps its markers while it is read again; a new range starts clean.
 const cacheKey=slow.run('scheduleMarkerState.key');await slow.run('showSchedule()');
 assert.equal(slow.run('scheduleMarkerState.key'),cacheKey);assert.match(slow.node('tools').innerHTML,/data-marker="insurance"/,'a refresh of the same day shows the facts it already has');
 slow.run('shiftSchedulePeriod(1)');const next=slow.run('showSchedule()');
 await next;assert.notEqual(slow.run('scheduleMarkerState.key'),cacheKey);
 const failing=fixture({replies:{'/schedule/markers?':{value:new Error('offline')}}});failing.c.fixtureAppointments=[todayAppointment('a','09:00','09:30')];
 await failing.run('showSchedule()');await new Promise(resolve=>setImmediate(resolve));
 assert.match(failing.node('schedule-head').innerHTML,/could not be loaded/);assert.match(failing.node('tools').innerHTML,/class="appt-card /,'the schedule still works without markers');

 // ---- Grid positions ----
 f=fixture();
 let layout=plain(f.run(`scheduleLayoutColumn(${JSON.stringify([appointment('a','09:00','09:30'),appointment('b','10:00','10:45')])},'${DAY}')`)).map(i=>[i.a.id,i.start,i.shownEnd-i.start,i.lane,i.lanes]);
 assert.deepEqual(layout,[['a',540,30,0,1],['b',600,45,0,1]],'typical visits fill the column at their own time and length');
 layout=plain(f.run(`scheduleLayoutColumn(${JSON.stringify([appointment('a','09:00','10:00'),appointment('b','09:30','10:00'),appointment('c','09:45','10:15'),appointment('d','10:00','10:30'),appointment('e','11:00','11:05')])},'${DAY}')`)).map(i=>[i.a.id,i.start,i.shownEnd-i.start,i.lane,i.lanes]);
 assert.deepEqual(layout,[['a',540,60,0,3],['b',570,30,1,3],['c',585,30,2,3],['d',600,30,0,3],['e',660,5,0,1]],'overlapping visits sit side by side; a free lane is reused; a short encounter retains its recorded duration');
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
 assert.match(html,/data-first="420" data-last="1140" data-display-last="1140" data-columns="2" data-max-lanes="1"/);assert.match(html,/class="grid-item" data-start="540" data-len="30" data-display-len="30" data-lane="0" data-lanes="1"/);
 assert.equal((html.match(/class="grid-hour"/g)||[]).length,12);assert.doesNotMatch(html,/data-now-line/,'no current-time line on another day');
 assert.doesNotMatch(html,/ style="/,'geometry is set through the style API, never inline attributes');
 f.run(`scheduleDate=scheduleToday()`);f.load([]);assert.match(f.run('scheduleDayCalendar()'),/data-now-line hidden/,'today carries the current-time line');f.run(`scheduleDate='${DAY}'`);
 assert.equal(f.run("scheduleGridTimeAt({dataset:{gridDay:'2030-11-15'},closest:()=>({dataset:{first:'420'}})},(14*60+20-420)*scheduleZoomScale.comfortable)"),'2030-11-15T14:15','a click lands on the quarter hour it falls in');

 // ---- Provider columns only when needed ----
 const columns=()=>plain(f.run('scheduleDayColumns()')).map(col=>[col.provider,col.label,col.appointments.length,col.blocks.length]);
 f.load([appointment('a','09:00','09:30'),appointment('b','10:00','10:30')]);
 assert.deepEqual(columns(),[['p1','Dr. Dana Owner',2,0],['p2','Dr. Sam Rivera',0,0]],'all checked providers keep a column');
 f.load([]);assert.deepEqual(columns(),[['p1','Dr. Dana Owner',0,0],['p2','Dr. Sam Rivera',0,0]]);
 f.load([appointment('a','09:00','09:30'),appointment('b','10:00','10:30',{clinician_id:'p2'})]);
 assert.deepEqual(columns(),[['p1','Dr. Dana Owner',1,0],['p2','Dr. Sam Rivera',1,0]],'two providers with visits: a column each');
 f.load([appointment('a','09:00','09:30')],[],[{id:'lunch',clinician_id:'p2',starts_at:at('12:00'),ends_at:at('13:00'),label:'Lunch',version:1}]);
 assert.deepEqual(columns(),[['p1','Dr. Dana Owner',1,0],['p2','Dr. Sam Rivera',0,1]],'a blocked provider keeps a column so the block has a place');
 html=f.run('scheduleDayCalendar()');assert.match(html,/class="grid-block"[^>]*data-schedule-block="lunch" data-start="720" data-len="60"/);assert.match(html,/data-grid-provider="p2"/);
 f.run("scheduleProvider='p2'");f.load([appointment('b','10:00','10:30',{clinician_id:'p2'})]);
 assert.deepEqual(columns(),[['p2','Dr. Sam Rivera',1,0]],'a chosen provider: a single wide column');
 f.run("scheduleProvider=''");f.load([]);assert.deepEqual(columns(),[['p1','Dr. Dana Owner',0,0],['p2','Dr. Sam Rivera',0,0]]);
 // A provider who has left still shows the encounters they had.
 f.load([appointment('a','09:00','09:30'),appointment('old','10:00','10:30',{clinician_id:'left',provider_label:'Dr. Former'})]);
 assert.deepEqual(columns().map(col=>col[1]),['Dr. Dana Owner','Dr. Sam Rivera','Dr. Former']);

 // ---- Status wording ----
 assert.deepEqual(plain(f.run("['booked','checked_in','in_progress','completed','cancelled','no_show'].map(scheduleStatusLabel)")),['Booked','Checked in','In progress','Completed','Cancelled','No-show']);
 assert.equal(f.run("scheduleStatusLabel('awaiting_review')"),'Awaiting review','an unknown state is shown as recorded, in sentence case');
 assert.equal(Object.keys(plain(f.run('scheduleStatusLabels'))).includes('confirmed'),false,'no state is invented');
 html=f.run(`scheduleCard(${JSON.stringify(appointment('a','09:00','09:30',{status:'checked_in',category:'Telehealth',title:'Video visit'}))},'day')`);
 assert.match(html,/class="appt-card appt-day status-checked_in type-telehealth"/,'status and visit type are separate channels');
 assert.match(html,/aria-label="[^"]*Checked in/,'status remains accessible in the block label');
 assert.match(html,/<strong class="appt-patient">Example, a<\/strong><span class="appt-meta">9:00 · 30m · Video visit · Dr\. Dana Owner<\/span>/);
 assert.doesNotMatch(html,/owner@example\.test/,'the provider is named, not shown by sign-in email');
 f.run("scheduleProviders=[{id:'p1',label:'owner@example.test'}]");assert.match(f.run(`scheduleCard(${JSON.stringify(appointment('a','09:00','09:30',{provider_label:'Dr. Recorded Name'}))},'day')`),/Dr\. Recorded Name/,'a name recorded with the encounter beats an email in the provider list');
 f.run('scheduleProviders=[]');assert.match(f.run(`scheduleCard(${JSON.stringify(appointment('a','09:00','09:30'))},'day')`),/owner@example\.test/,'the email is the last resort when no name exists');
 f.run("scheduleProviders=[{id:'p1',label:'Dr. Dana Owner'},{id:'p2',label:'Dr. Sam Rivera'}]");
 assert.deepEqual(plain(f.run("['Office visit','New patient','Follow-up','Telehealth','Procedure','Nurse check',''].map(category=>scheduleVisitType({category}))")),['office','new','followup','telehealth','procedure','other','other']);

 // ---- Every marker state, and its absence ----
 const base={appointment_id:'a',patient_id:'patient-a',new_patient:false,visit_id:null,forms:null,insurance:{status:'self_pay'},copay:null,balance_cents:0,charges:null,note:null};
 const markersFor=(facts,status='booked',variant='day')=>{f.load([appointment('a','09:00','09:30',{status})],[{...base,...facts}]);return plain(f.run('scheduleMarkerList(scheduleState.appointments[0])'));};
 const one=(facts,kind,status)=>markersFor(facts,status).filter(m=>m.kind===kind).map(m=>[m.label,m.tone]);
 assert.deepEqual(one({forms:{status:'sent',packet_id:'k'}},'forms'),[['Forms sent','grey']]);
 assert.deepEqual(one({forms:{status:'in_progress',packet_id:'k'}},'forms'),[['Forms started','grey']]);
 assert.deepEqual(one({forms:{status:'submitted',packet_id:'k'}},'forms'),[['Forms in','info']]);
 assert.deepEqual(one({forms:{status:'reviewed',packet_id:'k'}},'forms'),[['Forms done','green']]);
 assert.deepEqual(one({forms:null},'forms'),[],'nothing when no form was sent');
 f.load([appointment('a','09:00','09:30')],[base]);html=f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')");
 assert.match(f.run('schedulePanelFacts(scheduleState.appointments[0])'),/data-board-action="send-intake"/,'sending intake remains in the detail card');
 f.c.me.role='nurse';assert.doesNotMatch(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')"),/send-intake/);f.c.me.role='owner';
 f.load([appointment('a','09:00','09:30',{status:'completed'})],[base]);assert.doesNotMatch(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')"),/send-intake/,'not offered once the encounter is over');
 assert.deepEqual(one({insurance:{status:'active',coverage_id:'c'}},'insurance'),[['Active','green']]);
 assert.deepEqual(one({insurance:{status:'not_active',coverage_id:'c'}},'insurance'),[['Not active','red']]);
 assert.deepEqual(one({insurance:{status:'not_checked',coverage_id:'c'}},'insurance'),[['Insurance not checked','amber']]);
 assert.deepEqual(one({insurance:{status:'check_failed',coverage_id:'c'}},'insurance'),[['Check failed','red']]);
 assert.deepEqual(one({insurance:{status:'self_pay'}},'insurance'),[['Self-pay','grey']]);
 assert.deepEqual(one({copay:{due_cents:1500,paid_cents:0,test_paid_cents:0}},'copay'),[['Copay $15 due','amber']]);
 assert.deepEqual(one({copay:{due_cents:2550,paid_cents:1000,test_paid_cents:0}},'copay'),[['Copay $15.50 due','amber']],'part payments leave the rest due');
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
 assert.deepEqual(one({note:'in_progress',visit_id:'v'},'note','booked'),[],'no note marker before the encounter starts');
 assert.deepEqual(one({charges:'posted',visit_id:'v'},'charges','completed'),[['Charges posted','green']]);
 assert.deepEqual(one({charges:'draft',visit_id:'v'},'charges','completed'),[['Charges draft','amber']]);
 assert.deepEqual(one({charges:'none',visit_id:'v'},'charges','completed'),[['No charges','amber']]);
 assert.deepEqual(one({charges:'none',visit_id:'v'},'charges','in_progress'),[],'a visit still under way is not nagged about charges');
 for(const marker of markersFor({new_patient:true,forms:{status:'submitted',packet_id:'k'},insurance:{status:'not_active',coverage_id:'c'},copay:{due_cents:1500,paid_cents:0,test_paid_cents:0},balance_cents:4500,note:'in_progress',charges:'draft',visit_id:'v'},'completed'))assert(marker.tip.length>10&&marker.label,`${marker.kind} has a tooltip and a text label`);
 html=f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')");
 assert.equal((html.match(/<svg class="marker-icon"/g)||[]).length,(html.match(/class="appt-marker /g)||[]).length,'each marker is an icon and a label');
 assert.equal((html.match(/data-marker-appointment="a"/g)||[]).length,2,'the grid shows its two highest-priority marker actions');
 assert.match(html,/class="appt-more-markers">\+5</);
 assert.equal((f.run("scheduleMarkersHtml(scheduleState.appointments[0],'row')").match(/data-marker-appointment="a"/g)||[]).length,7,'the list exposes all recorded marker actions');
 // Markers not yet loaded: no markers and no misleading offer.
 f.run("scheduleMarkerState={key:'k',items:new Map(),loaded:false,failed:false}");assert.doesNotMatch(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')"),/data-marker=/);
 // Day and Week summarize, while Month and List keep the full marker set.
 const busy={new_patient:true,forms:{status:'submitted',packet_id:'k'},insurance:{status:'not_active',coverage_id:'c'},copay:{due_cents:1500,paid_cents:0,test_paid_cents:0},balance_cents:4500};
 for(const variant of ['day','week','compact','row']){
  f.load([appointment('a','09:00','09:30')],[{...base,...busy}]);
  const grid=['day','week'].includes(variant),markerHtml=f.run(`scheduleMarkersHtml(scheduleState.appointments[0],'${variant}')`);
  assert.deepEqual(markerLabels(markerHtml).map(m=>m.label),['Not active','Copay $15 due','Forms in','Owes $45','New patient'].slice(0,grid?2:5));
  if(grid)assert.match(markerHtml,/class="appt-more-markers">\+3</);
 }

 // ---- A role without billing access ----
 f.load([appointment('a','09:00','09:30',{status:'completed'})],[{appointment_id:'a',patient_id:'patient-a',new_patient:true,visit_id:'v',forms:{status:'submitted',packet_id:'k'},note:'in_progress'}]);
 assert.deepEqual(markerLabels(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'row')")).map(m=>m.kind),['forms','note','new'],'no insurance, copay, balance or charges markers without billing facts');
 html=f.run('schedulePanelFacts(scheduleState.appointments[0])');assert.match(html,/Intake form/);assert.match(html,/Visit note/);assert.doesNotMatch(html,/Insurance|Copay|Balance|Charges|collect-copay|check-eligibility/);
 assert.doesNotMatch(f.run('scheduleSummaryHtml()'),/insurance not checked/);

 // ---- Summary counts double as filters ----
 f.load([appointment('a','08:00','08:30',{status:'completed'}),appointment('b','09:00','09:30',{status:'checked_in'}),appointment('c','09:30','10:00',{status:'checked_in'}),appointment('d','10:00','10:30',{status:'in_progress'}),appointment('e','11:00','11:30'),appointment('f','11:30','12:00'),appointment('g','13:00','13:30',{status:'cancelled'}),appointment('h','14:00','14:30',{status:'no_show'})],
  [{...base,appointment_id:'b',forms:{status:'submitted',packet_id:'kb'}},{...base,appointment_id:'c',forms:{status:'submitted',packet_id:'kc'}},{...base,appointment_id:'e',forms:{status:'submitted',packet_id:'ke'},insurance:{status:'not_checked',coverage_id:'ce'}},{...base,appointment_id:'f',insurance:{status:'not_checked',coverage_id:'cf'}},{...base,appointment_id:'g',forms:{status:'submitted',packet_id:'kg'},insurance:{status:'not_checked',coverage_id:'cg'}},{...base,appointment_id:'a',insurance:{status:'not_checked',coverage_id:'ca'}}]);
 f.run("scheduleMode='day';scheduleFilter='all'");
 const summary=()=>f.run('scheduleSummaryOptionsHtml()').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
 assert.match(summary(),/8 appointments · 2 checked in · 1 in progress · 3 forms to review · 2 insurance not checked/,'all visible appointments are counted while cancelled and no-show visits add no forms or insurance work');
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
 assert.match(html,/<summary>More ▾<\/summary>/);assert.match(html,/data-new-block/);assert.match(html,/data-calendar-sync/);
 assert.match(html,/data-schedule-shift="-1"/);assert.match(html,/data-schedule-today/);assert.doesNotMatch(html,/name="date"|name="provider"/);
 assert.deepEqual([...html.matchAll(/data-schedule-view="([a-z_]+)"[^>]*aria-pressed="(true|false)">([A-Za-z]+)</g)].map(m=>m.slice(1)),[['day','true','Day'],['week_grid','false','Week'],['month','false','Month'],['week','false','List']],'day, week, month and list views all stay available');
 assert.match(html,/Friday, November 15, 2030/);assert.doesNotMatch(html,/entries|Updates automatically|Select a patient to manage|America\/Chicago|Month calendar|agenda/i);
 f.c.me.role='read_only';html=f.run('scheduleHeadHtml()');assert.doesNotMatch(html,/data-new-block|data-new-appointment/);f.c.me.role='owner';
 // The default action saves a view independently of opening a calendar day.
 await f.click({scheduleView:'week_grid'});assert.equal(f.run('scheduleMode'),'week_grid');assert.equal(f.store.get('suncharts.schedule.default-view.tenant.p1.chosen-view'),'week_grid');
 assert.doesNotMatch(f.run('scheduleHeadHtml()'),/Make Week my default view/);
 await f.click({scheduleView:'sideways'});assert.equal(f.run('scheduleMode'),'week_grid');
 await f.click({calendarDay:'2030-11-22'});assert.deepEqual(plain(f.run('[scheduleMode,scheduleDate]')),['day','2030-11-22']);assert.equal(f.store.get('suncharts.schedule.default-view.tenant.p1.chosen-view'),'week_grid');
 await f.click({scheduleZoom:'compact'});assert.equal(f.store.get('suncharts.schedule.default-view.tenant.p1.zoom'),'compact');assert.match(f.run('scheduleDayCalendar()'),/zoom-compact/);
 f.run(`scheduleDate='${DAY}';scheduleMode='day';scheduleZoom='comfortable'`);

 // ---- Month: three compact cards, then "+N more" ----
 f.load([appointment('a','08:00','08:30'),appointment('b','09:00','09:30'),appointment('c','10:00','10:30'),appointment('d','11:00','11:30'),appointment('e','13:00','13:30'),appointment('x','09:00','09:30',{starts_at:at('09:00','2030-11-19'),ends_at:at('09:30','2030-11-19')})],[{...base,appointment_id:'a',...busy}]);
 f.run("scheduleMode='month'");html=f.run('scheduleMonthCalendar()');
 const cell=html.split('<td ').find(part=>part.includes('data-calendar-day="2030-11-15"'));
 assert.equal((cell.match(/class="appt-card appt-compact /g)||[]).length,3);assert.match(cell,/<button type="button" class="calendar-more" data-calendar-day="2030-11-15"[^>]*>\+2 more<\/button>/);
 assert.match(cell,/aria-label="Open Friday, November 15, 2030, 5 appointments"/);assert.deepEqual(markerLabels(cell).map(m=>m.label),['Not active','Copay $15 due','Forms in','Owes $45','New patient']);
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
 const actions=(status,role='owner',extra={},mine=true)=>{f.c.me={role,user_id:mine?'p1':'someone',tenant_id:'tenant'};f.load([appointment('a','09:00','09:30',{status})],[{...facts,...extra}]);const panel=f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])");return [...new Set([...panel.matchAll(/data-board-action="([a-z-]+)"|data-(schedule-start|schedule-edit|schedule-chart|schedule-pick-move)=|<option value="(cancel|no_show)"/g)].map(m=>m[1]||m[2]||m[3]))].sort();};
 assert.deepEqual(actions('booked'),[...new Set(['check-in','schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','schedule-edit','schedule-pick-move','cancel'])].sort());
 f.load([appointment('past','09:00','09:30',{starts_at:'2020-01-06T15:00:00Z',ends_at:'2020-01-06T15:30:00Z'})],[]);
 assert.match(f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, past',[])"),/<option value="cancel">Cancel appointment<\/option><option value="no_show">Patient did not show up<\/option>/,'a no-show can be recorded once the time has passed');
 assert.deepEqual(actions('checked_in'),[...new Set(['schedule-start','schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','cancel'])].sort());
 assert.deepEqual(actions('checked_in','owner',{},false),[...new Set(['schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','cancel'])].sort(),'another clinician’s visit is not started from here');
 assert.deepEqual(actions('in_progress','owner',{visit_id:'v',note:'in_progress',charges:'draft'}),[...new Set(['visit','start-note','send-intake','schedule-chart','check-eligibility','insurance','collect-copay','billing','charges'])].sort());
 assert.deepEqual(actions('completed','owner',{visit_id:'v',note:'signed',charges:'posted',copay:{due_cents:1500,paid_cents:1500,test_paid_cents:0},forms:{status:'reviewed',packet_id:'k'}}),[...new Set(['visit','schedule-chart','review-intake','check-eligibility','insurance','collect-copay','billing','visit','charges'])].sort());
 assert.deepEqual(actions('cancelled'),[...new Set(['schedule-chart','billing'])].sort(),'a cancelled visit offers nothing to do but look');
 assert.deepEqual(actions('no_show'),[...new Set(['schedule-chart','billing'])].sort());
 assert.deepEqual(markersFor({new_patient:true,forms:{status:'submitted',packet_id:'k'},insurance:{status:'not_checked',coverage_id:'c'},copay:{due_cents:1500,paid_cents:0,test_paid_cents:0},balance_cents:4500},'cancelled').map(m=>m.label),['Owes $45'],'a cancelled visit carries no to-do markers');
 assert.deepEqual(markersFor({copay:{due_cents:1500,paid_cents:1500,test_paid_cents:0}},'no_show').map(m=>m.label),['Copay paid'],'money already taken stays visible');
 assert.deepEqual(actions('booked','front_desk'),[...new Set(['check-in','schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','schedule-edit','schedule-pick-move','cancel'])].sort());
 assert.deepEqual(actions('checked_in','front_desk'),[...new Set(['schedule-chart','send-intake','check-eligibility','insurance','collect-copay','billing','cancel'])].sort(),'the front desk does not start visits');
 assert.deepEqual(actions('checked_in','nurse'),[...new Set(['schedule-start','schedule-chart','insurance','billing'])].sort(),'rooming staff start the encounter but do not send forms, take payment or cancel');
 assert.deepEqual(actions('booked','read_only'),[...new Set(['schedule-chart','insurance','billing'])].sort(),'a read-only role can only look');
 assert.deepEqual(actions('booked','owner',{forms:{status:'submitted',packet_id:'k'}}).filter(a=>['check-in','schedule-chart','review-intake'].includes(a)),[...new Set(['check-in','schedule-chart','review-intake'])].sort());
 f.c.me={role:'owner',user_id:'p1',tenant_id:'tenant'};
 const limited=fixture({denied:['billing']});limited.load([appointment('a','09:00','09:30',{status:'booked'})],[facts]);
 assert.doesNotMatch(limited.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])"),/collect-copay|check-eligibility/,'no payment or eligibility actions without billing access');
 // Each action reaches the route or flow that already exists.
 const act=async(action,status,extra={},replies={})=>{const g=fixture({replies});g.load([appointment('a','09:00','09:30',{status})],[{...facts,...extra}]);g.run("scheduleSelected='a';showSchedule=async()=>{calls.push(['reload']);};appointmentDetail=async id=>{calls.push(['detail',id]);}");await g.click({boardAction:action,appointment:'a'});return g;};
 let g=await act('check-in','booked');
 assert.deepEqual(plain(g.calls.filter(call=>call[0]==='api').map(call=>call.slice(1,3))),[['/api/v1/appointments/a/check-in','POST'],['/api/v1/patients/patient-a/coverages/coverage-a/claimmd-eligibility/check','POST']]);
 assert.equal(g.calls.find(call=>call[1]?.includes?.('/claimmd-eligibility/check'))[3].automatic,true);
 assert.deepEqual(plain(g.calls.slice(-3)),[['reload'],['detail','a'],['notice','Patient checked in.',false]]);
 g=await act('check-in','checked_in');await assert.rejects(g.c.pending,/Only a booked appointment/);assert.equal(g.calls.filter(call=>call[0]==='api').length,0);
 g=await act('send-intake','booked',{},{'/intake-forms':{method:'POST',value:{packet_id:'packet',intake_url:'/intake?token=synthetic',expires_at:'2030-12-15T00:00:00Z',replaced:0,practice_name:'Synthetic Clinic'}}});
 assert.deepEqual(plain(g.calls.find(call=>call[0]==='api').slice(1,4)),['/api/v1/patients/patient-a/intake-forms','POST',{appointment_id:'a'}]);
 assert.match(g.run("schedulePanelLink(scheduleState.appointments[0])"),/value="http:\/\/localhost:8099\/intake\?token=synthetic"/);assert.match(g.calls.at(-1)[1],/link is ready/);
 g.c.me={role:'nurse',user_id:'n',tenant_id:'tenant'};await g.click({boardAction:'send-intake',appointment:'a'});await assert.rejects(g.c.pending,/cannot send intake forms/);
 g=await act('check-eligibility','booked',{},{'/claimmd-eligibility/check':{method:'POST',value:{outcome:'checked'}}});
 let sent=g.calls.find(call=>call[0]==='api');assert.equal(sent[1],'/api/v1/patients/patient-a/coverages/coverage-a/claimmd-eligibility/check');assert.equal(sent[2],'POST');assert.equal(sent[3].automatic,false);assert.equal(sent[3].appointment_id,'a');assert.match(sent[3].request_id,/^request-/);
 assert(g.calls.some(call=>call[0]==='reload'),'the markers are read again after a check');
 g=await act('check-eligibility','booked',{},{'/claimmd-eligibility/check':{method:'POST',value:{outcome:'needs',needs:[{kind:'payer_id'}]}}});
 assert.deepEqual(plain(g.calls.filter(call=>['clinical','select','section'].includes(call[0]))),[['select','patient-a',null],['section','insurance']],'a check that needs an answer continues in the chart’s insurance step');
 assert.equal(g.c.insuranceAppointmentSelection.get('patient-a'),'a');
 g=await act('check-eligibility','booked',{insurance:{status:'self_pay'}});await assert.rejects(g.c.pending,/no active insurance/);assert.equal(g.calls.filter(call=>call[0]==='api').length,0);
 g=await act('collect-copay','checked_in');
 assert.deepEqual(plain(g.calls.filter(call=>call[0]!=='notice')),[['select','patient-a',null],['section','visits']],'the copay is taken on the appointment in the Encounters tab, not the Insurance tab');
 assert.equal(g.c.copayAppointmentSelection.get('patient-a'),'a','the chart shows this appointment’s copay, not another one’s');
 g=await act('collect-copay','in_progress',{visit_id:'visit-a'});
 assert.deepEqual(plain(g.calls.filter(call=>call[0]!=='notice')),[['select','patient-a','visit-a'],['encounter','charges'],['collect']],'with the encounter started, its own Billing opens with the payment window');
 g=await act('billing','booked');assert.deepEqual(plain(g.calls.at(-1)),['section','billing']);
 g=await act('visit','in_progress',{visit_id:'visit-a'});assert.deepEqual(plain(g.calls),[['select','patient-a','visit-a']]);
 g=await act('charges','completed',{visit_id:'visit-a'});assert.deepEqual(plain(g.calls),[['select','patient-a','visit-a'],['encounter','charges']]);
 g=await act('visit','in_progress');await assert.rejects(g.c.pending,/No visit has been started/);
 g=await act('review-intake','checked_in',{forms:{status:'submitted',packet_id:'packet-a'}});assert.deepEqual(plain(g.calls),[['intake','packet-a']]);
 // Start visit keeps the schedule's existing handler.
 g=fixture({replies:{'/api/v1/visits':{method:'POST',value:{id:'new-visit'}}}});g.load([appointment('a','09:00','09:30',{status:'checked_in'})],[facts]);await g.click({scheduleStart:'a',patient:'patient-a'});
 assert.deepEqual(plain(g.calls).map(row=>row.slice(0,4)),[['api','/api/v1/visits','POST',{appointment_id:'a'}],['select','patient-a','new-visit'],['encounter','visit']]);
 // An assigned clinician can start today's booked visit directly. Front desk still checks it in.
 g=fixture();g.load([todayAppointment('a','09:00','09:30')],[]);
 assert.match(g.run('schedulePanelNext(scheduleState.appointments[0])'),/data-board-action="check-in-start"[^>]*>Check in &amp; start encounter</);
 g.c.me={role:'front_desk',user_id:'front',tenant_id:'tenant'};
 assert.match(g.run('schedulePanelNext(scheduleState.appointments[0])'),/data-board-action="check-in"[^>]*>Check in</);
 // Repeat clicks while check-in is in flight, then recover the encounter if the start response is lost.
 let checkedIn;
 const submittedCheckIn=new Promise(done=>{checkedIn=done;});
 g=fixture({replies:{
  '/appointments/a/check-in':{method:'POST',value:()=>submittedCheckIn},
  '/api/v1/visits':{method:'POST',value:new Error('Start response lost')},
  '/patients/patient-a/workspace':{value:{visits:[{id:'other',appointment_id:'a',patient_id:'patient-b'},{id:'recovered',appointment_id:'a',patient_id:'patient-a'}]}}
 }});
 g.load([todayAppointment('a','09:00','09:30')]);g.run("scheduleSelected='a';scheduleRefreshAfter=async()=>{};");
 const first=g.run('scheduleStartAppointment(scheduleState.appointments[0],true)');
 await g.run('scheduleStartAppointment(scheduleState.appointments[0],true)');checkedIn({});
 await first;
 assert.equal(g.calls.filter(c=>c[1]?.endsWith?.('/check-in')).length,1);
 assert.equal(g.calls.filter(c=>c[1]==='/api/v1/visits'&&c[2]==='POST').length,1);
 assert.deepEqual(plain(g.calls.filter(c=>c[0]==='select')),[['select','patient-a','recovered']]);
 // Reschedule and cancel stay on the existing editor and action form.
 html=actions('booked')&&f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])");assert.match(html,/<form id="schedule-action" data-id="a" data-version="1">/);assert.match(html,/data-schedule-edit="a">Edit appointment/);
 // Markers lead to the place that deals with them.
 const marker=async(kind,status,extra)=>{
  const h=fixture(),focused=[];
  const details={open:false,querySelector:selector=>({focus(){focused.push(selector);}})};
  h.c.document.querySelector=selector=>selector==='.schedule-encounter-details'?details:null;
  h.load([appointment('a','09:00','09:30',{status})],[{...facts,...extra}]);
  h.run("appointmentDetail=async id=>{calls.push(['detail',id]);}");
  await h.click({marker:kind,markerAppointment:'a'});
  await h.c.pending;
  assert.equal(details.open,true);
  assert.deepEqual(focused,[`[data-schedule-fact="${kind}"]`]);
  return plain(h.calls);
 };
 assert.deepEqual(await marker('forms','booked',{forms:{status:'submitted',packet_id:'packet-a'}}),[['detail','a'],['intake','packet-a']]);
 assert.deepEqual(await marker('forms','booked',{forms:{status:'sent',packet_id:'packet-a'}}),[['detail','a']]);
 assert.deepEqual(await marker('insurance','booked'),[['detail','a']]);
 assert.deepEqual((await marker('copay','booked')).at(-1),['section','visits']);
 assert.deepEqual((await marker('balance','booked')).at(-1),['section','billing']);
 assert.deepEqual(await marker('note','completed',{visit_id:'visit-a',note:'in_progress'}),[['detail','a']]);
 assert.deepEqual((await marker('charges','completed',{visit_id:'visit-a',charges:'draft'})).at(-1),['encounter','charges']);
 assert.deepEqual(await marker('new','booked',{new_patient:true}),[['detail','a'],['select','patient-a',null],['section','profile']]);

 // ---- Check insurance for the day: one at a time, on the server's terms ----
 const dayFacts=[{...base,appointment_id:'a',insurance:{status:'not_checked',coverage_id:'c1'}},{...base,appointment_id:'b',insurance:{status:'not_checked',coverage_id:'c2'}},{...base,appointment_id:'c',insurance:{status:'not_checked',coverage_id:'c3'}},{...base,appointment_id:'d',insurance:{status:'not_checked',coverage_id:'c1'}},{...base,appointment_id:'e',insurance:{status:'active',coverage_id:'c5'}},{...base,appointment_id:'g',insurance:{status:'not_checked',coverage_id:'c6'}}];
 const dayVisits=[appointment('a','08:00','08:30'),appointment('b','09:00','09:30'),appointment('c','10:00','10:30'),appointment('d','11:00','11:30',{patient_id:'patient-a'}),appointment('e','12:00','12:30'),appointment('g','13:00','13:30',{status:'cancelled'})];
 let inFlight=0,most=0;const answers={c1:{outcome:'checked'},c2:{outcome:'checked'},c3:{outcome:'needs'}};
 g=fixture({replies:{'/claimmd-eligibility/check':{method:'POST',value:async route=>{inFlight++;most=Math.max(most,inFlight);await new Promise(resolve=>setImmediate(resolve));inFlight--;return answers[route.split('/coverages/')[1].split('/')[0]];}}}});
 g.load(dayVisits,dayFacts);g.run("scheduleMode='day'");
 assert.match(g.run('scheduleSummaryOptionsHtml()'),/data-board-action="check-day-insurance">Check insurance for this day</);
 g.c.fixtureAppointments=dayVisits;g.c.fixtureMarkers=dayFacts.map(m=>m.appointment_id==='a'||m.appointment_id==='d'?{...m,insurance:{status:'active',coverage_id:'c1'}}:m.appointment_id==='b'?{...m,insurance:{status:'not_active',coverage_id:'c2'}}:m);
 await g.click({boardAction:'check-day-insurance'});await new Promise(resolve=>setImmediate(resolve));
 const checks=g.calls.filter(call=>call[0]==='api'&&call[2]==='POST');
 assert.deepEqual(checks.map(call=>call[1].split('/coverages/')[1].split('/')[0]),['c1','c2','c3'],'each coverage is asked once; checked, cancelled and finished visits are skipped');
 assert(checks.every(call=>call[3].automatic===true&&call[3].appointment_id),'the server applies its own freshness rules and request limit');assert.equal(most,1,'one request at a time');
 assert.equal(g.run('scheduleBatchMessage'),'2 checked · 1 not active · 1 could not be checked');assert.match(g.calls.at(-1)[1],/2 checked · 1 not active · 1 could not be checked/);
 g=fixture({replies:{'/claimmd-eligibility/check':{method:'POST',value:{outcome:'skipped',reason:'rate_limited'}}}});g.load(dayVisits,dayFacts);g.run("scheduleMode='day'");g.c.fixtureAppointments=dayVisits;g.c.fixtureMarkers=dayFacts;
 await g.click({boardAction:'check-day-insurance'});
 assert.equal(g.calls.filter(call=>call[0]==='api'&&call[2]==='POST').length,1,'it stops asking once the request limit is reached');assert.match(g.run('scheduleBatchMessage'),/0 checked · 0 not active · 3 could not be checked \(the insurer request limit/);
 g.c.me.role='clinician';assert.doesNotMatch(g.run('scheduleSummaryOptionsHtml()'),/check-day-insurance/,'offered to the owner and the front desk');
 g.c.me.role='front_desk';assert.match(g.run('scheduleSummaryOptionsHtml()'),/check-day-insurance/);g.run("scheduleMode='month'");assert.doesNotMatch(g.run('scheduleSummaryOptionsHtml()'),/check-day-insurance|Scheduled/,'a day-view tool');

 // ---- Clicking an empty time books there with that provider ----
 g=fixture();g.load([appointment('a','09:00','09:30')],[]);g.run("appointmentEditor=async(...args)=>{calls.push(['book',...args]);};reviewScheduleMove=async(...args)=>{calls.push(['move',...args]);}");
 const grid={dataset:{first:'420',last:'1140'}},column={dataset:{gridDay:DAY,gridProvider:'p2'},hasAttribute:()=>false,closest:selector=>selector==='[data-grid-column]'?column:selector==='.schedule-grid'?grid:null};
 const gridClick=event=>{for(const listener of g.listeners.get('click'))if(!listener.capture)listener.callback(event);};
 const scale=g.run('scheduleZoomScale.comfortable');
 gridClick({target:column,offsetY:(13*60+40-420)*scale});await g.c.pending;
 assert.deepEqual(plain(g.calls.at(-1)),['book',null,null,null,DAY,`${DAY}T13:30`,'p2']);
 gridClick({target:{closest:selector=>selector==='[data-grid-column]'?column:null,hasAttribute:()=>false},offsetY:10});assert.equal(g.calls.length,1,'a click on a card or block is not a click on empty time');
 g.run("scheduleDrag={id:'a',version:1,provider:'p1'}");gridClick({target:column,offsetY:(15*60-420)*scale});await g.c.pending;
 assert.deepEqual(plain(g.calls.at(-1)),['move','a',`${DAY}T15:00`,'p2',1],'with a move in hand, the click reviews the move');
 g.c.me.role='read_only';gridClick({target:column,offsetY:100});assert.equal(g.calls.length,2,'a read-only role cannot book');

 // ---- Forty appointments ----
 const many=Array.from({length:40},(_,i)=>appointment('n'+i,`${String(8+Math.floor(i/4)).padStart(2,'0')}:${['00','15','30','45'][i%4]}`,`${String(8+Math.floor((i+2)/4)).padStart(2,'0')}:${['00','15','30','45'][(i+2)%4]}`,{clinician_id:i%2?'p1':'p2',status:['booked','checked_in','in_progress','completed'][i%4]}));
 g=fixture();g.load(many,many.map(a=>({...base,appointment_id:a.id,...busy,note:'in_progress',charges:'draft',visit_id:'v'})));g.run("scheduleMode='day'");
 const started=process.hrtime.bigint();for(let i=0;i<20;i++)g.run('renderSchedule()');const each=Number(process.hrtime.bigint()-started)/20e6;
 assert.equal((g.node('tools').innerHTML.match(/class="appt-card /g)||[]).length,40);assert(each<25,`a 40-appointment day renders in ${each.toFixed(1)}ms`);
 g.c.fixtureAppointments=many;await g.run('showSchedule()');assert.equal(g.calls.filter(call=>call[0]==='api').length,3,'a 40-appointment day is three reads: providers, appointments, markers');

 // ---- Keeping the page current without getting in the way ----
 g=fixture();g.c.fixtureAppointments=[todayAppointment('a','09:00','09:30')];await g.run("showSchedule({view:'day'})");await g.run('scheduleMarkersReady');
 g.node('tools').hidden=false;g.calls.length=0;
 await g.run('refreshScheduleQuietly()');await g.run('scheduleMarkersReady');
 assert.deepEqual(g.calls.filter(call=>call[0]==='api').map(call=>call[1].split('?')[0]).sort(),['/api/v1/schedule','/api/v1/schedule/markers','/api/v1/schedule/providers'],'a refresh reads the schedule and its markers again');
 assert.equal(g.calls.some(call=>call[0]==='tool'),false,'a quiet refresh does not move the page');
 for(const busyWith of ["$('schedule-detail').hidden=false","$('tools').hidden=true","document.visibilityState='hidden'","scheduleDrag={id:'a'}","scheduleBatchMessage='Checking insurance… 1 of 2'"]){
  const h=fixture();h.c.fixtureAppointments=[todayAppointment('a','09:00','09:30')];await h.run('showSchedule()');await h.run('scheduleMarkersReady');h.node('tools').hidden=false;h.calls.length=0;
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
 console.log('PASS schedule board: Month default and device memory, grid placement, provider columns, status wording, every marker and its absence, billing-free roles, panel actions by status and role, day insurance check, summary filters, month overflow, escaping, booking by time and theme-only colours');
}
module.exports={fixture:createFixture,appointment,DAY,at,plain,markerLabels};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
