// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
process.env.TZ='America/Chicago';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const nodes=new Map(),listeners=new Map(),calls=[];let pending,fail=false;
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',hidden:true,textContent:''});return nodes.get(id);};
const original={id:'a1',version:3,status:'booked',clinician_id:'p1',patient_id:'patient',starts_at:'2026-10-26T14:00:00Z',ends_at:'2026-10-26T14:45:00Z',title:'Synthetic follow-up',category:'Follow-up',facility:'Synthetic clinic',room:'1',notes:'Keep these details',patient_name:'Synthetic <test>',provider_label:'Provider one'};
const c=vm.createContext({Date,Intl,URLSearchParams,console,me:{role:'owner',user_id:'p1'},$:node,
 document:{getElementById:node,addEventListener(t,f){listeners.set(t,[...(listeners.get(t)||[]),f]);}},
 localTime:s=>{const d=new Date(s),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;},
 esc:s=>String(s??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),date:s=>new Date(s).toISOString(),
 FormData:class{constructor(f){this.f=f;}*[Symbol.iterator](){yield* Object.entries(this.f.values);}},
 run:fn=>{pending=fn();},notice:s=>calls.push(['notice',s]),original,
 api:async(path,method='GET',body,version)=>{calls.push({path,method,body,version});if(method==='PUT'){if(fail)throw new Error('provider, patient or room conflict');return {...original,...body,version:4};}return {...original};},calls
});
const evaluate=s=>vm.runInContext(s,c);
evaluate(fs.readFileSync('web/scheduling.js','utf8'));
evaluate("scheduleDate='2026-10-28';scheduleMode='week_grid';scheduleProviders=[{id:'p1',label:'Provider one'},{id:'p2',label:'Provider two'}];scheduleState={appointments:[original],blocks:[{id:'b1',clinician_id:'p2',starts_at:'2026-10-26T15:00:00Z',ends_at:'2026-10-26T16:00:00Z',label:'Lunch block'}]};schedulePanel=html=>{$('schedule-detail').innerHTML=html;};");
(async()=>{
 assert.equal(evaluate('scheduleWeekDays()[0]'),'2026-10-26');assert.equal(evaluate('scheduleWeekDays()[6]'),'2026-11-01');
 const bounds=evaluate('scheduleBounds()');assert(new Date(bounds.end)-new Date(bounds.start)<=8*86400000);
 let html=evaluate('scheduleWeekCalendar()');assert.match(html,/colspan="2"/);assert.match(html,/Provider two/);assert.match(html,/Lunch block/);assert.match(html,/Synthetic &lt;test&gt;/);assert.match(html,/data-drag-appointment="a1"/);assert.match(html,/slot-continuation/);
 c.me.role='read_only';html=evaluate('scheduleWeekCalendar()');assert.doesNotMatch(html,/draggable="true"|data-slot-book=/);c.me.role='owner';
 let proposal=evaluate("proposeScheduleMove(original,'2026-10-27T11:30','p2')");assert.equal(proposal.version,3);assert.equal(new Date(proposal.body.ends_at)-new Date(proposal.body.starts_at),45*60000);assert.equal(proposal.body.notes,original.notes);assert.equal(proposal.body.room,'1');assert.equal(proposal.body.clinician_id,'p2');assert.equal(proposal.body.patient_id,undefined);
 assert.throws(()=>evaluate("proposeScheduleMove({...original,status:'in_progress'},'2026-10-27T11:30','p2')"),/Only booked/);
 assert.throws(()=>evaluate("proposeScheduleMove(original,'2026-11-01T01:30','p2')"),/occurs twice/);
 assert.throws(()=>evaluate("proposeScheduleMove(original,'2026-03-08T02:30','p2')"),/does not exist/);
 await assert.rejects(evaluate("reviewScheduleMove('a1','2026-10-27T11:30','p2',2)"),/changed while dragging/);
 const dragButton={dataset:{dragAppointment:'a1'}};
 listeners.get('dragstart')[0]({target:{closest:()=>dragButton},dataTransfer:{setData(){}}});
 const cell={dataset:{dropTime:'2026-10-27T11:30',dropProvider:'p2'}};
 let prevented=false;listeners.get('drop')[0]({target:{closest:()=>cell},preventDefault(){prevented=true;}});await pending;
 assert(prevented);assert.match(node('schedule-detail').innerHTML,/Review appointment move/);assert.equal(calls.filter(a=>a.method==='PUT').length,0);
 const button={disabled:false},form={id:'schedule-move-form',dataset:{id:'a1',version:'3'},values:{reason:'Synthetic reschedule'},querySelector:()=>button};
 const submit=listeners.get('submit')[0];
 fail=true;submit({target:form,preventDefault(){}});await pending;
 assert.match(node('schedule-move-error').textContent,/conflict/);assert.equal(button.disabled,false);assert.equal(evaluate('scheduleMove.version'),3);
 assert.equal(original.starts_at,'2026-10-26T14:00:00Z');
 fail=false;evaluate("showSchedule=async()=>calls.push(['reload']);appointmentDetail=async id=>calls.push(['detail',id]);");
 submit({target:form,preventDefault(){}});await pending;
 const saved=calls.filter(a=>a.method==='PUT').at(-1);assert.equal(saved.version,3);assert.equal(saved.body.reason,'Synthetic reschedule');assert.equal(saved.body.notes,original.notes);assert.equal(saved.body.clinician_id,'p2');assert.equal(evaluate('scheduleMove'),undefined);
 console.log('PASS week calendar: provider columns, slots, blocks, continuation, permissions, DST rejection, drag review, stale versions, conflict retention and exact versioned reschedule submission');
})().catch(e=>{console.error(e);process.exitCode=1;});
