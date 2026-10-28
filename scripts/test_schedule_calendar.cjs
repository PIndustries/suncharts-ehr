// SPDX-License-Identifier: AGPL-3.0-only
// Calendar fixtures exercise local dates, bounded reads and existing action routes.
'use strict';
process.env.TZ='America/Chicago';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const nodes=new Map(),listeners=new Map(),calls=[];
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:''});return nodes.get(id);};
let pending;
const c=vm.createContext({Date,Intl,URLSearchParams,console,
 document:{getElementById:node,addEventListener(type,cb,capture){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({cb,capture});}},
 localTime:value=>{const d=new Date(value),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;},
 esc:value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
 me:{role:'owner',user_id:'provider'},$:node,showTool:name=>calls.push(['tool',name]),run:fn=>{pending=fn();},calls,
 api:async route=>{
  calls.push(['api',route]);if(route.endsWith('/providers'))return {items:[{id:'provider',label:'Synthetic clinician'}]};
  return {appointments:[{id:'overlap',starts_at:'2026-03-22T04:00:00Z',ends_at:'2026-03-22T07:00:00Z',patient_name:'Synthetic <script>',provider_label:'Provider <img>',status:'booked',title:'Synthetic visit'}],blocks:[]};
 }
});
const run=code=>vm.runInContext(code,c);
run(fs.readFileSync(path.resolve(__dirname,'../web/scheduling.js'),'utf8'));
(async()=>{
 run("scheduleDate='2028-02-29';scheduleMode='month'");
 const days=JSON.parse(JSON.stringify(run('scheduleCalendarDays()')));
 assert.equal(days.length,42);assert.equal(days[0],'2028-01-30');assert(days.includes('2028-02-29'));assert.equal(days[41],'2028-03-11');
 run("scheduleDate='2026-01-31';shiftSchedulePeriod(1)");assert.equal(run('scheduleDate'),'2026-02-01');
 run('shiftSchedulePeriod(-2)');assert.equal(run('scheduleDate'),'2025-12-01');
 run("scheduleDate='2026-03-08';scheduleMode='month'");await run('showSchedule()');
 const requests=calls.filter(a=>a[0]==='api'&&a[1].includes('/schedule?')).map(a=>new URLSearchParams(a[1].split('?')[1]));
 assert.equal(requests.length,2);for(const q of requests)assert(new Date(q.get('end'))-new Date(q.get('start'))<=31*86400000);
 assert.equal(requests[0].get('end'),requests[1].get('start'));
 assert.equal(run('scheduleState.appointments.length'),1);assert.equal(run("scheduleEntriesForDay('2026-03-21').length"),1);assert.equal(run("scheduleEntriesForDay('2026-03-22').length"),1);
 let html=node('tools').innerHTML;assert.match(html,/Month calendar/);assert.match(html,/March 2026/);assert.match(html,/Synthetic &lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/data-schedule-open="overlap"/);assert.match(html,/data-calendar-book=/);
 c.me.role='read_only';run('renderSchedule()');assert.doesNotMatch(node('tools').innerHTML,/data-calendar-book=/);
 c.me.role='owner';
 run("showSchedule=async()=>calls.push(['show',scheduleDate,scheduleMode]);appointmentEditor=async(a,b,c,day)=>calls.push(['book',day]);appointmentDetail=async id=>calls.push(['detail',id]);");
 const click=listeners.get('click').find(x=>!x.capture).cb;
 async function dispatch(dataset){const b={dataset,type:'button',hasAttribute:()=>false,closest:()=>true};click({target:{closest:()=>b}});await pending;}
 await dispatch({calendarDay:'2026-03-22'});assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['show','2026-03-22','day']);
 await dispatch({calendarBook:'2026-04-03'});assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['book','2026-04-03']);
 await dispatch({scheduleOpen:'overlap'});assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),['detail','overlap']);
 console.log('PASS month calendar: leap/year boundaries, DST-bounded requests, overlap deduplication, escaping, roles, day drilldown, booking date and existing appointment actions');
})().catch(e=>{console.error(e);process.exitCode=1;});
