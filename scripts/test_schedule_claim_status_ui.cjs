// SPDX-License-Identifier: AGPL-3.0-only
// Schedule claim chips: what each chip says, where the panel row leads, and the two
// summary counts above the calendar. Synthetic fixtures only; no browser or server.
'use strict';
process.env.TZ='America/Chicago';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const sources=['web/display-format.js','web/scheduling.js','web/schedule-board.js'].map(read);
const plain=value=>JSON.parse(JSON.stringify(value));
const DAY='2030-11-15',CLAIM='11111111-1111-4111-8111-111111111111',at=(time,day=DAY)=>new Date(`${day}T${time}:00-06:00`).toISOString();
const appointment=(id,start,end,extra={})=>({id,version:1,patient_id:'patient-'+id,clinician_id:'p1',starts_at:at(start),ends_at:at(end),status:'booked',title:'Office visit',category:'Office visit',facility:'',room:'',notes:'',patient_name:'Example, '+id,provider_label:'owner@example.test',...extra});
const base={appointment_id:'a',patient_id:'patient-a',new_patient:false,visit_id:'visit-a',forms:null,insurance:{status:'self_pay'},copay:null,balance_cents:0,charges:'posted',note:'signed'};

function fixture(options={}){
 const nodes=new Map(),listeners=new Map(),calls=[],store=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',hidden:true,dataset:{},classList:{add(){},remove(){},toggle(){}},closest(){return this;},querySelector(){return null;},contains(){return false;}});return nodes.get(id);};
 const c=vm.createContext({Date,Intl,URLSearchParams,console,Map,Set,JSON,Math,Number,String,Array,Object,Promise,Error,
  crypto:{randomUUID:()=>`request-${calls.length}`},location:{origin:'http://localhost:8099',hash:''},
  localStorage:{getItem:key=>store.has(key)?store.get(key):null,setItem:(key,value)=>{store.set(key,String(value));}},
  document:{getElementById:node,addEventListener(type,callback,capture){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({callback,capture});},visibilityState:'visible',activeElement:null},
  localTime:value=>{const d=new Date(value),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;},
  esc:value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
  date:value=>new Date(value).toISOString(),me:{role:'owner',user_id:'p1',tenant_id:'tenant'},$:node,calls,
  showTool:name=>calls.push(['tool',name]),notice:(message,error=false)=>calls.push(['notice',message,error]),
  run:work=>{c.pending=Promise.resolve().then(work);return c.pending;},
  showClinical:async()=>calls.push(['clinical']),selectPatient:async(id,visit)=>{calls.push(['select',id,visit]);c.selected=id;if(visit)c.activeVisit={id:visit};},
  showChartSection:key=>calls.push(['section',key]),setEncounterSection:key=>calls.push(['encounter',key]),openWorkflowIntakePacket:async id=>calls.push(['intake',id]),
  showClaimsWorkspace:async()=>calls.push(['claims']),insuranceAppointmentSelection:new Map(),selected:undefined,workspace:undefined,activeVisit:undefined,
  workspaceResourceAllowed:(resource,action)=>!(options.denied||[]).includes(resource),
  api:async(route,method='GET')=>{calls.push(['api',route,method]);
   if(route.endsWith('/schedule/providers'))return {items:[{id:'p1',label:'Dr. Dana Owner'}],hours:null};
   if(route.includes('/schedule/markers?'))return {items:c.fixtureMarkers,billing:true,insurance:true,clinical:true};
   if(route.includes('/schedule?'))return {appointments:c.fixtureAppointments,blocks:c.fixtureBlocks};
   return {};}
 });
 c.fixtureMarkers=[];c.fixtureAppointments=[];c.fixtureBlocks=[];
 const run=code=>vm.runInContext(code,c);
 for(const source of sources)run(source);
 run(`scheduleDate='${DAY}';scheduleProviders=[{id:'p1',label:'Dr. Dana Owner'}]`);
 const load=(appointments,markers=[])=>{c.fixtureAppointments=appointments;c.fixtureMarkers=markers;run("scheduleState={appointments:given_appointments,blocks:[]};scheduleMarkerState={key:'k',items:new Map(given_markers.map(m=>[m.appointment_id,m])),loaded:true,failed:false}",{});};
 const click=async dataset=>{const button={dataset,type:'button',textContent:'',hasAttribute:name=>Object.hasOwn(dataset,name.replace(/^data-/,'').replace(/-([a-z])/g,(_,x)=>x.toUpperCase())),closest:selector=>selector==='button'||selector==='#schedule-workspace'?button:null};for(const listener of listeners.get('click'))if(!listener.capture)listener.callback({target:{closest:selector=>selector==='button'?button:null,hasAttribute:()=>false}});await c.pending.catch(()=>{});};
 // Load without the helper's own identifiers, so names stay out of the board's scope.
 const give=(appointments,markers)=>{const holder={given_appointments:plain(appointments),given_markers:plain(markers)};loadWith(appointments,markers,holder);};
 const loadWith=(appointments,markers,holder)=>{c.given=holder;c.fixtureAppointments=appointments;c.fixtureMarkers=markers;run("scheduleState={appointments:given.given_appointments,blocks:[]};scheduleMarkerState={key:'k',items:new Map(given.given_markers.map(m=>[m.appointment_id,m])),loaded:true,failed:false}")};
 return {c,run,node,listeners,calls,give,click,load:(a,m)=>give(a,m||[])};
}
const chips=html=>[...html.matchAll(/class="appt-marker tone-([a-z]+)" data-marker="([a-z]+)"[^>]*title="([^"]*)">.*?<span>([^<]*)<\/span>/g)].map(m=>({tone:m[1],kind:m[2],tip:m[3],label:m[4]}));
const sentence=status=>({not_sent:'Charges are posted but the claim has not been sent.',sent:'The claim was sent. No answer yet.',accepted:'The insurer accepted the claim for processing.',rejected:'The insurer rejected the claim. It needs fixing and resending.',answered:'The insurer has answered. Check the payment.'})[status];

async function main(){
 // ---- One chip per claim step, with its own words and colour ----
 let f=fixture();
 const chipFor=(claim,status='completed',variant='day')=>{f.load([appointment('a','09:00','09:30',{status})],[{...base,claim}]);return chips(f.run(`scheduleMarkersHtml(scheduleState.appointments[0],'${variant}')`)).filter(m=>m.kind==='claim');};
 assert.deepEqual(chipFor({status:'not_sent',claim_id:null}),[{tone:'amber',kind:'claim',tip:sentence('not_sent'),label:'Claim not sent'}]);
 assert.deepEqual(chipFor({status:'not_sent',claim_id:CLAIM}).map(m=>m.label),['Claim not sent'],'a claim prepared but not sent is still not sent');
 assert.deepEqual(chipFor({status:'sent',claim_id:CLAIM}),[{tone:'grey',kind:'claim',tip:sentence('sent'),label:'Claim sent'}]);
 assert.deepEqual(chipFor({status:'accepted',claim_id:CLAIM}),[{tone:'green',kind:'claim',tip:sentence('accepted'),label:'Claim accepted'}]);
 assert.deepEqual(chipFor({status:'rejected',claim_id:CLAIM}),[{tone:'red',kind:'claim',tip:sentence('rejected'),label:'Claim rejected'}]);
 assert.deepEqual(chipFor({status:'answered',claim_id:CLAIM}),[{tone:'green',kind:'claim',tip:sentence('answered'),label:'Insurer answered'}]);
 assert.deepEqual(chipFor(null),[],'a self-pay visit, unposted charges or no visit says nothing about a claim');
 assert.deepEqual(chipFor({status:'not_sent',claim_id:null},'in_progress'),[{tone:'amber',kind:'claim',tip:sentence('not_sent'),label:'Claim not sent'}],'a visit still open already has posted charges, so its unsent claim is shown');
 // Money facts stay on the card once the visit is closed, exactly like copay and balance.
 assert.deepEqual(chipFor({status:'not_sent',claim_id:null},'cancelled').map(m=>m.label),['Claim not sent']);
 assert.deepEqual(chipFor({status:'answered',claim_id:CLAIM},'no_show').map(m=>m.label),['Insurer answered']);
 assert.deepEqual(chipFor({status:'rejected',claim_id:CLAIM},'completed'),[{tone:'red',kind:'claim',tip:sentence('rejected'),label:'Claim rejected'}],'money work stays visible after the visit');
 assert.deepEqual(chipFor({status:'not_sent',claim_id:null},'completed','week').map(m=>m.label),['Claim not sent'],'the month and list cards keep a claim that still needs sending');
 assert.deepEqual(chipFor({status:'answered',claim_id:CLAIM},'completed','week').map(m=>m.label),['Insurer answered'],'a settled claim still shows where it stands on the small cards');

 // ---- The panel row, and where each button leads ----
 const panel=(claim,extra={},denied=[])=>{const g=fixture({denied});g.load([appointment('a','09:00','09:30',{status:'completed'})],[{...base,...extra,claim}]);return g.run('schedulePanelFacts(scheduleState.appointments[0])');};
 let html=panel({status:'rejected',claim_id:CLAIM});
 assert.match(html,/<dt>Insurance claim<\/dt><dd><span class="appt-fact-state tone-red">The insurer rejected the claim\. It needs fixing and resending\.<\/span>/,'the row says the same sentence as the chip');
 assert.match(html,new RegExp(`data-board-action="open-claim" data-appointment="a" data-claim="${CLAIM}">Open claim</button>`));
 html=panel({status:'not_sent',claim_id:null});
 assert.match(html,/<dt>Insurance claim<\/dt><dd><span class="appt-fact-state tone-amber">Charges are posted but the claim has not been sent\.<\/span>/);
 assert.match(html,new RegExp(`data-board-action="charges" data-appointment="a">Open visit billing</button>`),'with no claim yet the visit’s own billing step is the way in');
 assert.doesNotMatch(html,/data-claim=/);
 assert.doesNotMatch(panel(null),/Insurance claim/,'no claim, no row');
 const row=(claim,denied=[],extra={})=>{const g=fixture({denied});g.load([appointment('a','09:00','09:30',{status:'completed'})],[{...base,...extra,claim}]);const row=g.run('schedulePanelFacts(scheduleState.appointments[0])').match(/<dt>Insurance claim<\/dt>[\s\S]*?<\/dd>/)?.[0]||'';return [...row.matchAll(/data-board-action="([a-z-]+)"/g)].map(m=>m[1]);};
 assert.deepEqual(row({status:'sent',claim_id:CLAIM}),['open-claim']);
 // Without claims access the server leaves the claim out altogether, so there is no row.
 assert.deepEqual(row(null,['claims']),[]);
 assert.deepEqual(row({status:'not_sent',claim_id:null}),['charges']);
 assert.deepEqual(row({status:'not_sent',claim_id:null},[],{visit_id:null}),[],'nothing to open for a visit that has none');
 assert.deepEqual(row({status:'not_sent',claim_id:null},['billing']),[],'no billing access, no button');

 // ---- Clicks follow the routes that already exist ----
 const act=async(dataset,markers,denied=[])=>{const g=fixture({denied});g.run("appointmentDetail=async id=>{calls.push(['detail',id]);};openEncounterCharges=()=>{calls.push(['charges-editor']);}");g.load([appointment('a','09:00','09:30',{status:'completed'})],markers);await g.click(dataset);return {calls:plain(g.calls),error:String(g.c.pending&&await g.c.pending.then(()=>'',reason=>reason)),hash:g.c.location.hash};};
 let out=await act({marker:'claim',markerAppointment:'a'},[{...base,claim:{status:'sent',claim_id:CLAIM}}]);
 assert.deepEqual(out.hash,`#/claims/${CLAIM}`,'the chip opens the claim through the claims screen address');
 assert.deepEqual(out.calls,[],'no second mechanism is invented');
 out=await act({marker:'claim',markerAppointment:'a'},[{...base,claim:{status:'not_sent',claim_id:null}}]);
 assert.deepEqual(out.calls.at(-1),['encounter','charges'],'with no claim the chip opens the visit’s Charges & billing step');
 assert.equal(out.hash,'');
 out=await act({boardAction:'open-claim',appointment:'a',claim:CLAIM},[]);
 assert.deepEqual(out.hash,`#/claims/${CLAIM}`);
 out=await act({boardAction:'open-claim',appointment:'a',claim:'not-an-id'},[]);
 assert.match(out.error,/Open the schedule again/,'a bad identifier is refused before the address changes');assert.equal(out.hash,'');

 // ---- The summary line counts the visits that still need claim work ----
 const clock=value=>`${String(value).padStart(2,'0')}:00`;
 const visits=['a','b','c','d','e'].map((id,index)=>appointment(id,clock(9+index),clock(9+index+1),{status:'completed'}));
 const markers=visits.map(v=>({...base,appointment_id:v.id,patient_id:v.patient_id,claim:null}));
 const withClaim=(id,claim)=>markers.map(m=>m.appointment_id===id?{...m,claim}:m);
 const summary=g=>g.run('scheduleSummaryHtml()').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
 f=fixture();f.load(visits,withClaim('a',{status:'not_sent',claim_id:null}).map(m=>m.appointment_id==='b'?{...m,claim:{status:'rejected',claim_id:CLAIM}}:m));
 f.run("scheduleMode='day';scheduleFilter='all'");
 assert.match(summary(f),/5 appointments · 0 checked in · 0 in progress · 1 claims not sent · 1 claims rejected/);
 const shown=()=>[...f.run('scheduleDayCalendar()').matchAll(/data-schedule-open="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(shown().length,5,'everything is shown until a count is chosen');
 for(const [key,ids] of [['claim_not_sent',['a']],['claim_rejected',['b']]]){
  f.run('renderSchedule()');await f.click({scheduleFilter:key});
  assert.equal(f.run('scheduleFilter'),key);assert.deepEqual(shown(),ids,`the ${key} count shows only those visits`);
  assert.match(f.node('schedule-head').innerHTML,new RegExp(`data-schedule-filter="${key}"[^>]*aria-pressed="true"`));assert.match(f.node('schedule-head').innerHTML,/Show all/);
  await f.click({scheduleFilter:key});assert.equal(f.run('scheduleFilter'),'all','choosing the same count again shows everything');
 }
 // A claim answer or a voided claim is nobody's open work, and is never counted.
 f.load(visits,withClaim('a',{status:'answered',claim_id:CLAIM}));
 assert.doesNotMatch(summary(f),/claims not sent|claims rejected/,'counts that are zero are left out');
 f.load(visits,withClaim('a',{status:'not_sent',claim_id:null}));
 assert.match(summary(f),/· 1 claims not sent$/);assert.doesNotMatch(summary(f),/claims rejected/);
 f.load(visits,markers);assert.doesNotMatch(summary(f),/claims/);
 // The counts follow the visits on screen, whatever view is open.
 f.run("scheduleMode='month'");f.load(visits,withClaim('a',{status:'rejected',claim_id:CLAIM}));
 assert.match(summary(f),/1 claims rejected/);
 console.log('PASS schedule claim chips: every claim step with its own words and colour, the panel row and both destinations, clicks on the routes that already exist, and the two summary counts as filters');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
