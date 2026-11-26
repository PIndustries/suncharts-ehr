// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Synthetic booking payloads only; no server or persisted patient data.
const assert=require('node:assert/strict');
const {fixture}=require('./test_schedule_board_ui.cjs');
const NativeDate=Date,fixed=new NativeDate('2026-11-24T20:30:00-06:00');
class FixedDate extends NativeDate{
 constructor(...args){super(...(args.length?args:[fixed.getTime()]));}
 static now(){return fixed.getTime();}
}
async function main(){
 assert.equal(process.env.TZ,'America/Chicago');
 const f=fixture();f.c.Date=FixedDate;
 assert.equal(f.run('localIsoDate()'),'2026-11-24');
 assert.equal(f.run('new Date().toISOString().slice(0,10)'),'2026-11-25','fixture reproduces UTC rollover');
 f.c.sample=new NativeDate('2026-01-02T03:04:00-06:00');assert.equal(f.run('localIsoDate(sample)'),'2026-01-02','pads month and day');
 for(const [starts_at,expected] of [
  ['2026-11-24T20:30','2026-11-24'],
  ['2026-11-23T20:30','2026-11-23'],
  ['2026-11-26T09:00','2026-11-24'],
  ['2026-11-25T02:30:00Z','2026-11-24']
 ]){
  let coverage;
  f.c.api=async(url,method,body)=>{
   if(url==='/api/v1/patients')return {id:'synthetic-patient'};
   if(url.endsWith('/coverages')){coverage=body;return {};}
   return url.endsWith('/demographics')?{content:{}}:{id:'synthetic-patient'};
  };
  f.c.form={dataset:{newPatient:'1'}};
  f.c.data={starts_at,new_given_name:'Synthetic',new_family_name:'Patient',new_birth_date:'1990-01-01',new_phone:'2025550100',new_insurance_id:'synthetic-payer',new_member_id:'SYN-001'};
  await f.run('scheduleCreateBookingPatient(form,data)');
  assert.equal(coverage.content.effective_date,expected,`coverage starts at earlier of today and local appointment day (${starts_at})`);
 }
 console.log('PASS local calendar date and booking coverage at Chicago evening UTC rollover');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
