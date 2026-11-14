// SPDX-License-Identifier: AGPL-3.0-only
// Booking defaults: today opens at the next half hour, another day keeps the morning default, a clicked slot keeps its time.
'use strict';
process.env.TZ='America/Chicago';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const RealDate=Date;
const pad=n=>String(n).padStart(2,'0');
const stamp=(day,hour,minute)=>`${day}T${pad(hour)}:${pad(minute)}`;
// The local wall clock of an instant, as a browser in this timezone would show it.
const localOf=value=>{const d=new RealDate(value);return stamp(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,d.getHours(),d.getMinutes());};
// The clock is held at 09:17, well past the 09:00 start the form used to offer. The viewed day is
// picked at run time, so the times the form offers all exist locally wherever this test is run.
const HOUR=9,MINUTE=17;
const labels=day=>[stamp(day,HOUR,MINUTE),stamp(day,HOUR+1,MINUTE),stamp(day,9,0),stamp(day,9,30),stamp(day,14,0),stamp(day,14,30)];
const offsetOf=label=>new RealDate(`${label}:00`).getTimezoneOffset();
const CLOCK_DAY=['2026-02-11','2026-03-11','2026-06-10','2026-09-10','2026-11-10','2026-12-10','2027-02-10']
 .find(day=>labels(day).every(label=>localOf(new RealDate(`${label}:00`).getTime())===label)
  &&new Set(labels(day).map(offsetOf)).size===1);
const clock=()=>new RealDate(`${stamp(CLOCK_DAY,HOUR,MINUTE)}:00`);
class FakeDate extends RealDate{
 constructor(...args){if(args.length===0)return clock();super(...args);}
 static now(){return clock().getTime();}
}
const nodes=new Map(),listeners=new Map();
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',hidden:false,contains:()=>false,scrollIntoView(){},querySelector:()=>null,closest:()=>({classList:{add(){},remove(){}}})});return nodes.get(id);};
const c=vm.createContext({Date:FakeDate,Intl,JSON,URLSearchParams,console,crypto:{randomUUID:()=>'request-1'},
 document:{addEventListener(type,cb,capture){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({cb,capture});},activeElement:null,querySelectorAll:()=>[]},
 me:{role:'owner',user_id:'provider'},canSchedule:()=>true,$:node,
 localTime:value=>localOf(typeof value==='string'?value:value.getTime()),
 esc:value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
 scheduleToday:()=>localOf(clock().getTime()).slice(0,10),
 run:fn=>{c.pending=fn();},notice:()=>{},api:async route=>{if(route.endsWith('/patients'))return {items:[{id:'p1',given_name:'Synthetic',family_name:'Patient',mrn:'MRN-1'}],next_cursor:undefined};throw new Error('Unexpected '+route);}
});
const run=code=>vm.runInContext(code,c);
run(fs.readFileSync(path.resolve(__dirname,'../web/scheduling.js'),'utf8'));
const DAY=CLOCK_DAY,OTHER_DAY=localOf(new RealDate(`${CLOCK_DAY}T12:00:00`).getTime()+86400000);
const times=html=>[...html.matchAll(/name="(starts_at|ends_at)"[^>]*value="([^"]*)"/g)].map(m=>m[2]);
async function open(args){await run(`appointmentEditor(${args})`);return node('schedule-detail').innerHTML;}
(async()=>{
 assert.ok(CLOCK_DAY,'a viewable day with no clock change nearby');
 assert.equal(run('new Date().getTime()'),clock().getTime(),'the clock is held at 09:17');
 assert.equal(run('scheduleToday()'),DAY,'and the viewed day is today');
 // "+ Appointment" while viewing today: the next half hour, not a start time already gone by.
 let html=await open(`null,null,null,'${DAY}'`);
 assert.deepEqual(times(html),[stamp(DAY,9,30),stamp(DAY,10,0)],'the default start is the next half hour, ahead of the clock');
 assert.match(html,/<label>Search patients<input type="search" id="schedule-patient-search" placeholder="Name or record number"><\/label>/);
 assert.doesNotMatch(html,/Find a loaded patient|Name or medical record number/i);
 // Another day keeps the morning default it always had.
 html=await open(`null,null,null,'${OTHER_DAY}'`);
 assert.deepEqual(times(html),[stamp(OTHER_DAY,9,0),stamp(OTHER_DAY,9,30)]);
 // A clicked slot keeps its own time, and the half hour that follows it. The calendar hands the
 // editor as a local wall-clock time, which the form shows as it was clicked.
 const slot=stamp(DAY,14,0);
 html=await open(`null,null,null,'${DAY}','${slot}'`);
 assert.deepEqual(times(html),[slot,stamp(DAY,14,30)],'the clicked slot keeps its own time');
 console.log('PASS booking defaults: today opens at the next half hour, another day keeps 09:00, a clicked slot keeps its time, plain patient search wording');
})().catch(e=>{console.error(e);process.exitCode=1;});
