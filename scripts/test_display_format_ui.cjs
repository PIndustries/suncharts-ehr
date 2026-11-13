// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The shared helpers that format dates, times, statuses, people and counts for staff.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'web/display-format.js'),'utf8');
const context=vm.createContext({console,Date,Intl,Number,Object,String});
vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);

// Dates and times.
assert.equal(run("displayDate('2026-11-13')"),'Nov 13, 2026');
assert.equal(run("displayDate('1990-01-01')"),'Jan 1, 1990','a calendar date never shifts to the previous day');
assert.equal(run("displayDate('')"),'');assert.equal(run('displayDate(null)'),'');
assert.equal(run("displayDate('not a date')"),'not a date','unreadable values are shown as stored rather than hidden');
assert.equal(run("displayTime(new Date(2026,10,13,10,59))"),'10:59 AM');
assert.equal(run("displayDateTime(new Date(2026,10,13,10,59))"),'Nov 13, 2026, 10:59 AM');
assert.equal(run("displayAge('1990-01-01',new Date(2026,10,13))"),36);
assert.equal(run("displayAge('1990-12-25',new Date(2026,10,13))"),35,'the birthday has not happened yet this year');
assert.equal(run("displayAge('',new Date())"),null);
assert.equal(run("displayBirthDate('1990-01-01',new Date(2026,10,13))"),'Jan 1, 1990 (36)');
assert.equal(run("displayBirthDate('unknown')"),'unknown');

// Statuses: sentence case, one vocabulary, stored value untouched.
for(const [stored,shown] of Object.entries({booked:'Booked',checked_in:'Checked in',in_progress:'In progress','in progress':'In progress',completed:'Completed',cancelled:'Cancelled',no_show:'No-show',draft:'Draft',ready:'Ready to send',submitted:'Sent',accepted:'Accepted',rejected:'Rejected',paid:'Paid',original:'Original claim',posted:'Posted',signed:'Signed'}))assert.equal(context.displayStatus(stored),shown,stored);
assert.equal(context.displayStatus('needs_reconciliation'),'Needs reconciliation','unknown values become sentence case');
assert.equal(context.displayStatus(''),'');assert.equal(context.displayStatus(null),'');
assert.equal(context.displayStatusPill('checked_in'),'<span class="status-badge checked_in">Checked in</span>');
assert.equal(context.displayStatusPill('<img onerror=x>'),'<span class="status-badge _img_onerror_x_">&lt;img onerror=x&gt;</span>','status text is escaped and never becomes markup');
assert.equal(context.displayStatusPill(''),'');

// People by name; the sign-in email only when nothing else exists.
assert.equal(context.displayPerson({display_name:'Dr. Dana Owner',email:'owner@example.test'}),'Dr. Dana Owner');
assert.equal(context.displayPerson({given_name:'Dana',family_name:'Owner',email:'owner@example.test'}),'Dana Owner');
assert.equal(context.displayPerson({display_name:'owner@example.test',name:'Dana Owner'}),'Dana Owner','an email stored as the display name is skipped when a name exists');
assert.equal(context.displayPerson({email:'owner@example.test'}),'owner@example.test');
assert.equal(context.displayPerson('owner@example.test','Dana Owner'),'Dana Owner');
assert.equal(context.displayPerson('Dr. Dana Owner'),'Dr. Dana Owner');
assert.equal(context.displayPerson('owner@example.test'),'owner@example.test');
assert.equal(context.displayPerson(null),'');

// Counts agree in number.
assert.equal(context.displayCount(1,'appointment'),'1 appointment');
assert.equal(context.displayCount(0,'appointment'),'0 appointments');
assert.equal(context.displayCount(2,'entry','entries'),'2 entries');

// Loaded once, before every feature script, and served by the engine.
const index=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
assert.equal(index.split('<script src="/display-format.js" defer></script>').length,2);
assert.ok(index.indexOf('/display-format.js')<index.indexOf('/app.js'),'the helpers load before the application scripts');
assert.match(fs.readFileSync(path.join(root,'src/lib.rs'),'utf8'),/"\/display-format\.js"[\s\S]{0,200}include_str!\("\.\.\/web\/display-format\.js"\)/);
assert.doesNotMatch(source,/\bfetch\(|localStorage|innerHTML/,'formatting helpers read and store nothing');
console.log('PASS staff display formatting helpers');
