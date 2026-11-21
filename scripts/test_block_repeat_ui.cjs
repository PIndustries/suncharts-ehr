// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Repeating block time: the dates are worked out from how it repeats and the last day. Weekly
// repeats use the chosen weekdays (the start's own weekday when none is ticked), every 2 weeks
// counts weeks from the first block, and the words staff read name the rule and the last day.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('web/scheduling.js','utf8');
const part=src.slice(src.indexOf("const blockWeekdayNames="),src.indexOf('function blockRepeatRead('));
const ctx={Date,Math,Number,String,Set,Error};vm.createContext(ctx);vm.runInContext(part,ctx);
const raw=(repeat,until)=>ctx.blockRepeatPlan({starts_at:'2027-02-01T12:00',ends_at:'2027-02-01T13:00',repeat,until},[]);
const plan=(repeat,until,weekdays=[],start='2027-02-01T12:00',end='2027-02-01T13:00')=>JSON.parse(JSON.stringify(ctx.blockRepeatPlan({starts_at:start,ends_at:end,repeat,until},weekdays)));
const days=p=>Array.from(p.dates,d=>d.starts.slice(5,10));
assert.deepEqual(days(plan('daily','2027-02-04')),['02-01','02-02','02-03','02-04']);
assert.deepEqual(days(plan('weekdays','2027-02-09')),['02-01','02-02','02-03','02-04','02-05','02-08','02-09'],'weekends are left out');
assert.deepEqual(days(plan('weekly','2027-02-19',[1,3])),['02-01','02-03','02-08','02-10','02-15','02-17']);
assert.deepEqual(days(plan('weekly','2027-02-16')),['02-01','02-08','02-15'],'no weekday ticked means the weekday of the first block');
assert.deepEqual(days(plan('biweekly','2027-03-01',[1,3])),['02-01','02-03','02-15','02-17','03-01']);
assert.deepEqual(days(plan('monthly','2027-05-01')),['02-01','03-01','04-01','05-01']);
const lunch=plan('weekly','2027-02-19',[1,3]);
assert.deepEqual({...lunch.dates[0]},{starts:'2027-02-01T12:00',ends:'2027-02-01T13:00'},'every date keeps the local start and end time');
assert.match(lunch.repeat,/^Every week on Mon, Wed until Feb 19, 2027$/);
assert.match(plan('weekdays','2027-02-09').repeat,/^Every weekday until /);
// A block that runs past midnight keeps its length on every date.
assert.deepEqual({...plan('daily','2027-02-02',[],'2027-02-01T22:00','2027-02-02T02:00').dates[1]},{starts:'2027-02-02T22:00',ends:'2027-02-03T02:00'});
for(const [until,why] of [['',/last day/],['2027-02-01',/after the first block/],['2028-03-01',/up to a year/]]){let message='';try{raw('daily',until);}catch(error){message=error.message;}assert.match(message,why);}
assert.match(src,/data-block-series="following">Remove this and all later ones</);
console.log('PASS repeating block time: dates for daily, weekday, weekly, every 2 weeks and monthly repeats, kept local times, and plain refusals');
