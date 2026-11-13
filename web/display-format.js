// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// How staff see dates, times, statuses, people and counts. These functions only
// format what is shown; stored values and form inputs are never changed here.

// "2026-11-13" or a timestamp -> "Nov 13, 2026". Calendar dates never shift across time zones.
function displayDate(value){
 if(value===null||value===undefined||value==='')return '';
 const text=String(value),day=/^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
 const parsed=day?new Date(Number(day[1]),Number(day[2])-1,Number(day[3]),12):new Date(value);
 if(Number.isNaN(parsed.getTime()))return text;
 return parsed.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
}
// A timestamp -> "10:59 AM".
function displayTime(value){
 if(value===null||value===undefined||value==='')return '';
 const parsed=new Date(value);
 if(Number.isNaN(parsed.getTime()))return String(value);
 return parsed.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
}
// A timestamp -> "Nov 13, 2026, 10:59 AM".
function displayDateTime(value){
 if(value===null||value===undefined||value==='')return '';
 const parsed=new Date(value);
 if(Number.isNaN(parsed.getTime()))return String(value);
 return `${displayDate(parsed)}, ${displayTime(parsed)}`;
}
// Whole years since a "YYYY-MM-DD" birth date, or null when it cannot be worked out.
function displayAge(birthDate,today=new Date()){
 const day=/^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthDate??''));
 if(!day)return null;
 let age=today.getFullYear()-Number(day[1]);
 const month=today.getMonth()+1-Number(day[2]);
 if(month<0||(month===0&&today.getDate()<Number(day[3])))age--;
 return age>=0?age:null;
}
// "1990-01-01" -> "Jan 1, 1990 (36)".
function displayBirthDate(birthDate,today=new Date()){
 const shown=displayDate(birthDate),age=displayAge(birthDate,today);
 return shown&&age!==null?`${shown} (${age})`:shown;
}
const displayStatusLabels=Object.freeze({
 booked:'Booked',checked_in:'Checked in',in_progress:'In progress',completed:'Completed',cancelled:'Cancelled',canceled:'Cancelled',no_show:'No-show',
 signed:'Signed',unsigned:'Not signed',not_started:'Not started',
 draft:'Draft',ready:'Ready to send',queued:'Waiting to send',submitted:'Sent',sent:'Sent',accepted:'Accepted',rejected:'Rejected',denied:'Denied',paid:'Paid',
 partially_paid:'Partly paid',posted:'Posted',unposted:'Not posted yet',void:'Voided',voided:'Voided',open:'Open',closed:'Closed',pending:'Pending',failed:'Failed',
 original:'Original claim',replacement:'Corrected claim',active:'Active',inactive:'Inactive',unverified:'Not verified',verified:'Verified'
});
// A stored status such as "in_progress" -> "In progress". Unknown values become sentence case.
function displayStatus(value){
 if(value===null||value===undefined||value==='')return '';
 const key=String(value).trim().toLowerCase().replace(/[\s-]+/g,'_');
 if(Object.prototype.hasOwnProperty.call(displayStatusLabels,key))return displayStatusLabels[key];
 const words=key.replaceAll('_',' ').trim();
 return words?words[0].toUpperCase()+words.slice(1):'';
}
function displayEscape(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
// The same label inside the existing coloured pill; the stored value stays the pill's class.
function displayStatusPill(value){
 const label=displayStatus(value);if(!label)return '';
 const key=String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_');
 return `<span class="status-badge ${displayEscape(key)}">${displayEscape(label)}</span>`;
}
// A person by name. Accepts a record or a string; the sign-in email is used only when no name exists.
function displayPerson(person,fallback=''){
 const looksLikeEmail=text=>/^[^\s@]+@[^\s@]+$/.test(text);
 const clean=value=>typeof value==='string'?value.trim():'';
 if(typeof person==='string'){const text=clean(person);return text&&!looksLikeEmail(text)?text:clean(fallback)||text;}
 const record=person||{};
 const full=[clean(record.given_name),clean(record.family_name)].filter(Boolean).join(' ');
 const names=[record.display_name,record.provider_name,record.clinician_name,record.staff_name,record.name,full,record.label].map(clean).filter(Boolean);
 return names.find(name=>!looksLikeEmail(name))||clean(fallback)||clean(record.email)||names[0]||'';
}
// displayCount(1,'appointment') -> "1 appointment"; displayCount(2,'entry','entries') -> "2 entries".
function displayCount(count,singular,plural){
 const amount=Number(count)||0;
 return `${amount} ${amount===1?singular:(plural||singular+'s')}`;
}
if(typeof module!=='undefined'&&module.exports)module.exports={displayDate,displayTime,displayDateTime,displayAge,displayBirthDate,displayStatus,displayStatusPill,displayPerson,displayCount};
