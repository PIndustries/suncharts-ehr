// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Facility and room on the appointment form are chosen from the practice's list, never typed:
// free text breaks room conflict checks and automation. A location already on an appointment
// stays selectable; changing the facility resets the room to that facility's rooms.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

class El{
 constructor(tag){this.tagName=tag.toUpperCase();this.attrs={};this.dataset={};this.listeners={};this.children=[];this._value='';this._html='';this.options=[];this.disabled=false;this.required=false;}
 setAttribute(k,v){this.attrs[k]=v;}
 addEventListener(k,fn){(this.listeners[k]=this.listeners[k]||[]).push(fn);}
 dispatch(k){for(const fn of this.listeners[k]||[])fn({target:this});}
 replaceWith(node){const i=this.parent.children.indexOf(this);this.parent.children[i]=node;node.parent=this.parent;}
 appendChild(n){this.children.push(n);n.parent=this;}
 querySelector(sel){const name=/\[name="(\w+)"\]/.exec(sel)?.[1];return this.children.find(c=>c.name===name)||null;}
 set innerHTML(html){this._html=html;this.options=[...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(m=>({value:m[1].replace(/&amp;/g,'&'),text:m[2]}));if(!this.options.some(o=>o.value===this._value))this._value=this.options[0]?.value??'';}
 get innerHTML(){return this._html;}
 set value(v){this._value=this.tagName==='SELECT'&&!this.options.some(o=>o.value===v)?(this.options[0]?.value??''):v;}
 get value(){return this._value;}
}
function form(existing){
 const f=new El('form');f.id='schedule-booking';
 for(const [name,value] of Object.entries(existing)){const i=new El('input');i.name=name;i.value=value;f.appendChild(i);}
 return f;
}
async function run(existing,items,edit=false,hasMore=false){
 const f=form(existing);f.dataset.id=edit?'existing':'';
 const ctx={console,Promise,Set,esc,me:{user_id:'u'},document:{createElement:t=>new El(t),addEventListener(){}},
  $:id=>id==='schedule-booking'?f:null,api:async url=>{assert.equal(url,'/api/v1/schedule/locations');return {items,has_more:hasMore};}};
 vm.createContext(ctx);
 const src=fs.readFileSync('web/scheduling.js','utf8');
 vm.runInContext(src.slice(src.indexOf('function scheduleSoleFacility('),src.indexOf('async function appointmentEditor(')),ctx);
 await ctx.attachScheduleLocations();
 return {f,facility:f.querySelector('[name="facility"]'),room:f.querySelector('[name="room"]'),hint:f.children.find(c=>c.tagName==='P')};
}
const texts=s=>s.options.map(o=>o.text);
(async()=>{
 const items=[{name:'Main Clinic',rooms:[{name:'Room 1'},{name:'Room 2'}]},{name:'North Office',rooms:[{name:'Suite A'}]},{name:'Annex',rooms:[]}];
 // New appointment: both are dropdowns; room waits for a facility.
 {
  const {facility,room}=await run({facility:'',room:''},items);
  assert.equal(facility.tagName,'SELECT');assert.equal(room.tagName,'SELECT');
  assert.deepEqual(texts(facility),['Choose a facility','Main Clinic','North Office','Annex']);
  assert.deepEqual(texts(room),['Choose a facility first']);assert.equal(room.disabled,true);
  facility.value='Main Clinic';facility.dispatch('change');
  assert.deepEqual(texts(room),['No room','Room 1','Room 2']);assert.equal(room.disabled,false);
  room.value='Room 2';facility.value='North Office';facility.dispatch('change');
  assert.deepEqual(texts(room),['No room','Suite A']);assert.equal(room.value,'','a room from another facility is not kept');
  facility.value='Annex';facility.dispatch('change');
  assert.deepEqual(texts(room),['No rooms set up for this facility']);
 }
 {
  const singleton=[items[0]];
  assert.equal((await run({facility:'',room:''},singleton)).facility.value,'Main Clinic');
  assert.equal((await run({facility:'',room:''},singleton,true)).facility.value,'','editing an unassigned appointment preserves its location');
  assert.equal((await run({facility:'',room:''},singleton,false,true)).facility.value,'','a partial directory cannot determine a sole facility');
 }
 // An existing appointment keeps its location, even one no longer on the list.
 {
  const {facility,room}=await run({facility:'Main Clinic',room:'Old procedure room'},items);
  assert.equal(facility.value,'Main Clinic');assert.equal(room.value,'Old procedure room');
  assert.ok(texts(room).includes('Old procedure room (current)'));
 }
 // No facilities yet: the form says where to add them instead of offering a text box.
 {
  const {facility,hint}=await run({facility:'',room:''},[]);
  assert.equal(facility.tagName,'SELECT');assert.deepEqual(texts(facility),['No facilities set up yet']);
  assert.match(hint.textContent,/Practice administration/);
 }
 console.log('PASS appointment facility and room are dropdowns from the practice list; existing locations stay; rooms follow the facility');
})().catch(e=>{console.error(e);process.exitCode=1;});
