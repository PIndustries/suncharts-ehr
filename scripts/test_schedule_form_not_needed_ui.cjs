// SPDX-License-Identifier: AGPL-3.0-only
// The schedule says when an appointment was marked "No form needed": chip text,
// no send offer, and a plain line in the appointment panel. Synthetic fixtures only.
'use strict';
process.env.TZ='America/Chicago';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const sources=['web/display-format.js','web/scheduling.js','web/schedule-board.js'].map(read);
// A fixed Friday that is never today.
const DAY='2030-11-15',at=(time,day=DAY)=>new Date(`${day}T${time}:00-06:00`).toISOString();
const appointment=(id,start,end,extra={})=>({id,version:1,patient_id:'patient-'+id,clinician_id:'p1',starts_at:at(start),ends_at:at(end),status:'booked',title:'Office visit',category:'Office visit',facility:'',room:'',notes:'',patient_name:'Example, '+id,provider_label:'owner@example.test',...extra});
const markerLabels=html=>[...html.matchAll(/class="appt-marker tone-([a-z]+)" data-marker="([a-z]+)"[^>]*title="([^"]*)">.*?<span>([^<]*)<\/span>/g)].map(m=>({tone:m[1],kind:m[2],tip:m[3],label:m[4]}));

function fixture(){
 const nodes=new Map(),calls=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',hidden:true,dataset:{},classList:{add(){},remove(){},toggle(){}},closest(){return this;},querySelector(){return null;},contains(){return false;}});return nodes.get(id);};
 const c=vm.createContext({Date,Intl,URLSearchParams,console,Map,Set,JSON,Math,Number,String,Array,Object,Promise,Error,
  crypto:{randomUUID:()=>`request-${calls.length}`},location:{origin:'http://localhost:8099'},
  localStorage:{getItem:()=>null,setItem(){}},
  document:{getElementById:node,addEventListener(){},visibilityState:'visible',activeElement:null},
  localTime:value=>{const d=new Date(value),pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;},
  esc:value=>String(value??'').replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x])),
  date:value=>new Date(value).toISOString(),me:{role:'owner',user_id:'p1',tenant_id:'tenant'},$:node,calls,
  showTool:name=>calls.push(['tool',name]),notice:(message,error=false)=>calls.push(['notice',message,error]),
  run:work=>{c.pending=Promise.resolve().then(work);return c.pending;},
  showClinical:async()=>calls.push(['clinical']),selectPatient:async()=>{},showChartSection(){},setEncounterSection(){},openWorkflowIntakePacket:async()=>{},
  insuranceAppointmentSelection:new Map(),selected:undefined,workspace:undefined,activeVisit:undefined,
  workspaceResourceAllowed:()=>true,
  api:async route=>{calls.push(['api',route]);if(route.includes('/schedule/providers'))return {items:[{id:'p1',label:'Dr. Dana Owner'}],hours:null};return {};}
 });
 const run=code=>vm.runInContext(code,c);
 for(const source of sources)run(source);
 run(`scheduleDate='${DAY}';scheduleProviders=[{id:'p1',label:'Dr. Dana Owner'}]`);
 const load=markers=>{c.given={appointments:[appointment('a','09:00','09:30')],blocks:[],markers};run("scheduleState={appointments:given.appointments,blocks:given.blocks};scheduleMarkerState={key:'k',items:new Map(given.markers.map(m=>[m.appointment_id,m])),loaded:true,failed:false}")};
 return {c,run,node,load};
}

async function main(){
 const base={appointment_id:'a',patient_id:'patient-a',new_patient:false,visit_id:null,forms:null,insurance:{status:'self_pay'},copay:null,balance_cents:0,charges:null,note:null};
 const notNeeded={...base,forms:{status:'not_needed',packet_id:null}};
 let f=fixture();

 // The chip says "No form needed" in plain words.
 f.load([notNeeded]);
 const chips=markerLabels(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')")).filter(m=>m.kind==='forms');
 assert.deepEqual(chips.map(m=>[m.label,m.tone]),[['No form needed','grey']]);
 assert.equal(chips[0].tip,'No intake form is needed for this encounter.');

 // With a mark on file the card never offers to send a form…
 assert.doesNotMatch(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')"),/send-intake/,'a marked card does not offer to send a form');
 // A card with nothing sent has no forms badge. Sending remains in the appointment panel.
 f.load([{...base}]);
 assert.doesNotMatch(f.run("scheduleMarkersHtml(scheduleState.appointments[0],'day')"),/data-marker="forms"|data-board-action="send-intake"/);

 // The panel says the encounter needs no form, and offers no send button there either.
 f.load([notNeeded]);
 let panel=f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])");
 assert.match(panel,/No intake form is needed for this encounter\./);
 assert.doesNotMatch(panel,/No intake form has been sent\./,'a marked visit is not described as missing a form');
 assert.doesNotMatch(panel,/send-intake/);
 // With no mark and no form the panel keeps its old wording and its button.
 f.load([{...base}]);
 panel=f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])");
 assert.match(panel,/No intake form has been sent\./);
 assert.match(panel,/data-board-action="send-intake"/);
 // A live form still wins: a sent form shows its own state, not the mark's words.
 f.load([{...base,forms:{status:'sent',packet_id:'k'}}]);
 panel=f.run("schedulePanelHtml(scheduleState.appointments[0],'Example, a',[])");
 assert.match(panel,/Intake form sent\. The patient has not started it yet\./);
 assert.doesNotMatch(panel,/No intake form is needed for this encounter\./);

 console.log('PASS schedule no-form-needed marker: chip says "No form needed", no send offer, and the panel says no form is needed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
