// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
process.env.TZ='America/Chicago';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const nodes=new Map(),listeners=new Map(),calls=[];let pending;
const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',hidden:false,setAttribute(k,v){this[k]=v;}});return nodes.get(id);};
const localTime=s=>{const d=new Date(s),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;};
const c=vm.createContext({Date,Intl,JSON,URLSearchParams,console,crypto:{randomUUID:()=> 'fresh-request'},me:{role:'owner'},selected:'p1',canSchedule:()=>true,$:node,localTime,date:v=>new Date(v).toISOString(),scheduleLabel:s=>s.replaceAll('_',' '),
 esc:v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])),
 document:{addEventListener(t,cb,capture){if(!listeners.has(t))listeners.set(t,[]);listeners.get(t).push({cb,capture});}},
 FormData:class{constructor(f){this.f=f;}*[Symbol.iterator](){yield* Object.entries(this.f.values);}},
 run:fn=>{pending=fn();},showTool:()=>{},schedulePanel:html=>{node('panel').innerHTML=html;},notice:()=>{},
 api:async(path,method,body,version)=>{calls.push({path,method,body,version});if(path.endsWith('/preview'))return {ready_to_create:true,occurrences:body.occurrences.map(()=>({available:true}))};if(path.includes('/series/'))return {id:'s1',status:'active',version:2,frequency:'weekly',interval:1,timezone:'America/Chicago',occurrences:[{appointment_id:'a1',version:3,status:'booked',starts_at:'2090-01-01T16:00:00Z',title:'Synthetic <visit>'},{appointment_id:'a2',version:5,status:'completed',starts_at:'2026-01-01T16:00:00Z',title:'Earlier visit'}]};return {id:'s1'};},
 showSchedule:async()=>{},appointmentDetail:async()=>{},calls
});
vm.runInContext(fs.readFileSync('web/scheduling.js','utf8'),c);vm.runInContext(fs.readFileSync('web/appointment-workflows.js','utf8'),c);
vm.runInContext("schedulePanel=html=>{$('panel').innerHTML=html;};showSchedule=async()=>{};appointmentDetail=async()=>{};",c);
const run=code=>vm.runInContext(code,c),preview=node('preview');let reviewed=false;
const form={isConnected:true,dataset:{request:'request-1'},values:{repeat_frequency:'weekly',repeat_count:'3',repeat_interval:'1',starts_at:'2026-03-01T10:00',ends_at:'2026-03-01T10:45',patient_id:'p1',clinician_id:'c1',title:'Synthetic visit',category:'Follow-up',facility:'Clinic',room:'1',notes:'Keep note',reason:'Follow-up plan'},querySelector:s=>s==='#series-preview'?preview:s==='[data-series-reviewed]'?{checked:reviewed}:null};c.form=form;
(async()=>{
 const proposal=run('recurringProposal(form)');assert.equal(proposal.occurrences.length,3);assert.equal(proposal.occurrences[0].utc_offset_minutes,-360);assert.equal(proposal.occurrences[1].utc_offset_minutes,-300);assert(proposal.occurrences.every(o=>o.local_start.endsWith('10:00:00')));assert.equal(new Date(proposal.occurrences[1].ends_at)-new Date(proposal.occurrences[1].starts_at),45*60000);
 form.values.repeat_frequency='monthly';form.values.starts_at='2026-01-31T10:00';form.values.ends_at='2026-01-31T10:45';const monthly=run('recurringProposal(form)');assert(monthly.occurrences[1].local_start.startsWith('2026-02-28'));assert(monthly.occurrences[2].local_start.startsWith('2026-03-31'));
 form.values.repeat_frequency='weekly';form.values.starts_at='2026-03-01T10:00';form.values.ends_at='2026-03-01T10:45';
 await run('previewRecurring(form)');
 const draftBefore=run('seriesDraft');listeners.get('input')[0].cb({target:{closest:selector=>selector==='#schedule-booking'?form:selector==='#series-preview'?preview:null}});assert.equal(run('seriesDraft'),draftBefore);
 assert.match(preview.innerHTML,/Book reviewed series/);assert.equal(calls.filter(x=>x.path==='/api/v1/schedule/series').length,0);
 await assert.rejects(run('createReviewedSeries()'),/Review and confirm/);reviewed=true;form.values.room='2';await assert.rejects(run('createReviewedSeries()'),/details changed/);
 await run("showAppointmentSeries('s1')");assert.match(node('panel').innerHTML,/data-schedule-open="a1"/);assert.match(node('panel').innerHTML,/Synthetic &lt;visit&gt;/);const versions=JSON.parse(node('series-cancel-form')['data-occurrences']);assert.equal(versions.length,2);assert.equal(versions[1].version,5);
 const card=run("reminderCard({id:'r1',version:2,before_minutes:120,status:'accepted',channel:'email',destination:'synthetic@example.test',due_at:'2026-10-25T10:00:00Z',last_result:'<script>unsafe</script>'})");assert.match(card,/accepted/);assert.doesNotMatch(card,/class="reminder-action-form"/);assert.doesNotMatch(card,/<script>/);assert.match(card,/&lt;script&gt;/);
 const prefs={id:'reminder-preferences-form',dataset:{patient:'p1',version:'0'},classList:{contains:()=>false},values:{channel:'email',destination:'synthetic@example.test',consented:'on',verified:'on',reason:'Patient consent'}};
 run("reminderAppointment={id:'a1'}");listeners.get('submit').find(x=>x.capture).cb({target:prefs,preventDefault(){},stopImmediatePropagation(){}});await pending;const saved=calls.find(x=>x.path.includes('/reminder-preferences'));assert.equal(saved.version,0);assert.equal(saved.body.consented,true);assert.equal(saved.body.automatic_email,false);
 console.log('PASS recurring/reminder UI: DST-preserved cadence, short-month dates, immutable reviewed preview, full cancellation version vector, escaping and explicit versioned contact permission');
})().catch(e=>{console.error(e);process.exitCode=1;});
