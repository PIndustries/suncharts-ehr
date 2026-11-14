// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic DOM fixtures exercise the real note editor handlers; no browser or network.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../web',name),'utf8');
const app=read('app.js'),module_=read('visit-note.js'),style=read('style.css'),index=read('index.html');
const decode=value=>String(value||'').replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
const earlier={subjective:'Earlier S',objective:'Earlier O',assessment:'Earlier A',plan:'Earlier P',procedure:'Earlier procedure'};
const source=(overrides={})=>({visit_id:'visit-0',version:3,visit_date:'2026-11-04T15:00:00Z',signed_at:'2026-11-04T16:00:00Z',clinician_id:'author',clinician_name:'',same_clinician:true,note:{...earlier},...overrides});
function fixture({previous=source(),note=null,role='owner',clinician='author'}={}){
 const nodes=new Map(),listeners=new Map(),requests=[],asked=[];let answers=[];
 function node(id){
  if(nodes.has(id))return nodes.get(id);
  let html='';
  const n={id,hidden:false,disabled:false,isConnected:true,dataset:{},value:'',textContent:'',classList:{add(){},remove(){},contains:()=>false,toggle(){}},
   setAttribute(){},removeAttribute(){},addEventListener(){},replaceChildren(){this.innerHTML='';},querySelector(){return null;},focus(){},scrollIntoView(){}};
  Object.defineProperty(n,'innerHTML',{get:()=>html,set(value){html=value;if(id==='visit-editor')parseEditor(value);}});
  nodes.set(id,n);return n;
 }
 function parseEditor(html){
  for(const [id,old] of [...nodes])if(id!=='visit-editor'&&(id.startsWith('note-')||id.endsWith('-form'))){old.isConnected=false;nodes.delete(id);}
  for(const [,attributes,id] of html.matchAll(/<(?:div|p|button|span)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const n=node(id);n.hidden=/\shidden(?=[\s>]|$)/.test(attributes);}
  for(const match of html.matchAll(/<form id="([^"]+)"([^>]*)>([\s\S]*?)<\/form>/g)){
   const [,id,attributes,body]=match,form=node(id);form.values={};form.elements={};
   for(const [,key,value]of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g))form.dataset[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=decode(value);
   for(const input of body.matchAll(/<(input|textarea)\b([^>]*\bname="([^"]+)"[^>]*)>([^<]*)/g)){
    const [,tag,attrs,name,text]=input;form.values[name]=tag==='textarea'?decode(text):decode(attrs.match(/value="([^"]*)"/)?.[1]);
    form.elements[name]={get value(){return form.values[name];},set value(value){form.values[name]=value;}};
   }
  }
 }
 const known=id=>id==='visit-editor'||!(id.startsWith('note-')||id.endsWith('-form'));
 const context=vm.createContext({console,Date,Intl,URL,URLSearchParams,TextEncoder,crypto:{randomUUID:()=>'synthetic-request'},location:{search:'',hash:'',pathname:'/'},
  FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){yield*Object.entries(this.form.values||{});}},
  document:{documentElement:{classList:{add(){},remove(){}}},getElementById:id=>known(id)?node(id):nodes.get(id)||null,querySelectorAll:()=>[],addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(callback);}},
  window:{scrollTo(){},addEventListener(){}},fetch(){throw new Error('Unexpected network request');},billingWrite:()=>true,billingCan:()=>true,canDocument:()=>true,
  confirmAction:async(message,options)=>{asked.push({message,options});if(!answers.length)throw new Error('Unexpected question: '+message);return answers.shift();},
  localStorage:{setItem(){throw new Error('PHI must not be persisted');}},sessionStorage:{setItem(){throw new Error('PHI must not be persisted');}}
 });
 const run=code=>vm.runInContext(code,context);run(app);run(module_);
 context.testRequests=requests;context.testPrevious=previous;
 run(`api=async(path,method='GET',body,version)=>{testRequests.push({path,method,body,version});
  if(path.endsWith('/previous-note')){if(testPrevious==='fail')throw new Error('Synthetic failure');return {source:testPrevious};}
  if(path.endsWith('/note-authorship'))return {assigned:{id:activeVisit.clinician_id,name:'Dr. Assigned'},signed:null,amendments:[]};
  if(path.endsWith('/note'))return {...activeVisit,version:activeVisit.version+1,note:{...body,...(body.started_from?{started_from:{...body.started_from,visit_date:'2026-11-04T15:00:00Z'}}:{})}};
  if(path.endsWith('/sign'))return {...activeVisit,status:'signed'};throw new Error('Unexpected request '+path);};
 selectPatient=async()=>{};setEncounterSection=()=>{};
 me={tenant_id:'tenant-1',user_id:'author',role:${JSON.stringify(role)}};selected='patient-1';
 workspace={appointments:[{id:'appointment-1',title:'Synthetic visit',starts_at:'2026-11-11T12:00:00Z'}],visits:[],amendments:[],clinical:{items:[],reviews:[]},labs:{orders:[],reports:[],acknowledgments:[]},billing:{accounts:[]}};
 activeVisit={id:'visit-1',patient_id:selected,appointment_id:'appointment-1',clinician_id:${JSON.stringify(clinician)},status:'in_progress',version:1,note:${JSON.stringify(note)},vitals:null};
 workspace.visits=[activeVisit];renderVisit(false);`);
 const settle=async()=>{for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done));};
 const form=()=>nodes.get('note-form');
 function type(values){Object.assign(form().values,values);for(const callback of listeners.get('input')||[])callback({target:{closest:selector=>selector.includes('#note-form')?form():null}});}
 async function click(dataset,reply=[]){answers=[...reply];const button={id:'',type:'button',dataset,closest:()=>null,hasAttribute:()=>false};for(const callback of listeners.get('click')||[])callback({target:{closest:()=>button}});await settle();assert.equal(answers.length,0,'every prepared answer was used');}
 async function submit(){for(const callback of listeners.get('submit')||[])callback({target:form(),preventDefault(){}});await settle();}
 const editor=()=>nodes.get('visit-editor').innerHTML,bar=()=>nodes.get('note-previous')?.innerHTML||'';
 const from=()=>form().values.started_from?JSON.parse(form().values.started_from):null;
 return {run,context,nodes,requests,asked,settle,form,type,click,submit,editor,bar,from,noteForm:()=>editor().match(/<form id="note-form"[\s\S]*?<\/form>/)[0]};
}
const clearVisitNoteSessionCall='clearVisitNoteSession()';
const sections=['subjective','objective','assessment','plan','procedure'];
const text=(f,keys=sections)=>Object.fromEntries(keys.map(key=>[key,f.form().values[key]]));
const blank={subjective:'',objective:'',assessment:'',plan:'',procedure:''};
async function main(){
 let f=fixture();await f.settle();
 let note=f.noteForm();
 const order=[...note.matchAll(/<textarea name="([a-z]+)"/g)].map(match=>match[1]);
 assert.deepEqual(order,sections,'Procedure is the fifth section, after Plan');
 assert.match(note,/<div class="note-section note-procedure"><label>Procedure<textarea name="procedure" maxlength="10000" placeholder="Procedure performed, site, medication and dose, lot number, guidance, tolerance, complications">/);
 assert.doesNotMatch(note,/required/,'nothing is required while drafting: Save note takes any text, and signing is checked separately');
 assert.match(note,/<div id="note-message" class="note-message muted" role="status" hidden><\/div><div class="actions"><button type="submit">Save note<\/button>/,'a message line sits next to Save note and Sign encounter note, inside the form');
 assert.match(style,/\.note-section\.note-procedure\{grid-column:1\/-1\}/,'Procedure spans the row below Plan');
 assert.match(index,/<script src="\/visit-diagnoses\.js" defer><\/script><script src="\/visit-note\.js" defer><\/script>/);
 console.log('PASS Procedure appears below Plan in the editor with its hint and stays optional');

 assert.deepEqual(f.requests.map(r=>[r.method,r.path]),[['GET','/api/v1/visits/visit-1/previous-note']]);
 assert.match(f.bar(),/^<button type="button" class="primary" data-note-same="all">Same as last visit<\/button><span class="muted">From your visit on [^<]*2026<\/span>/,'offered prominently on an empty note, naming the source');
 assert.equal(f.nodes.get('note-previous').hidden,false);
 for(const key of sections)assert.equal(f.nodes.get('note-same-'+key).hidden,false,key+' has its own link');
 assert.match(note,/id="note-same-plan" data-note-same="plan" aria-label="Same as last visit: Plan" hidden>Same as last visit</);
 assert.equal(f.nodes.get('note-source-line').hidden,true);
 await f.click({noteSame:'all'});
 assert.equal(f.asked.length,0,'one click fills an empty note without a question');
 assert.deepEqual(text(f),earlier);
 assert.deepEqual(f.from(),{visit_id:'visit-0',version:3,sections});
 assert.match(f.nodes.get('note-source-line').textContent,/^Started from the visit on [^.]*2026\. Review every section before signing\.$/);
 assert.equal(f.nodes.get('note-source-line').hidden,false);
 assert.match(f.bar(),/role="status">Subjective, Objective, Assessment, Plan and Procedure brought in\. Review before signing\.<\/span><button type="button" class="text-button" data-note-undo>Undo<\/button>$/);
 assert.match(f.bar(),/<button type="button" class="" data-note-same="all">/,'no longer the primary action once the note has text');
 assert.deepEqual(f.run('visitDrafts.get("visit-1").note.values.plan'),'Earlier P','brought-in text is an ordinary retained draft');
 assert.match(f.nodes.get('visit-draft-status').textContent,/Unsaved note edits retained in this tab/);
 console.log('PASS one click fills an empty note, records where it came from and offers Undo');

 // The draft, its origin and the Undo step survive leaving and re-rendering the editor.
 f.run('captureVisitDrafts();renderVisit(false)');await f.settle();
 assert.deepEqual(text(f),earlier);assert.deepEqual(f.from().sections,sections);
 assert.match(f.editor(),/<p id="note-source-line" class="note-source muted">Started from the visit on [^<]*2026\. Review every section before signing\.<\/p>/);
 assert.match(f.bar(),/data-note-undo/);assert.equal(f.requests.length,1,'the earlier note is read once per visit');
 f.type({plan:'Earlier P, now edited'});
 await f.click({noteUndo:''});
 assert.deepEqual(text(f),{...blank,plan:'Earlier P, now edited'},'Undo never discards text edited after it was brought in');
 assert.deepEqual(f.from(),{visit_id:'visit-0',version:3,sections:['plan']});
 assert.match(f.bar(),/Plan kept because you edited it afterwards\. The rest was put back\./);assert.doesNotMatch(f.bar(),/data-note-undo/);
 f=fixture();await f.settle();await f.click({noteSame:'all'});await f.click({noteUndo:''});
 assert.deepEqual(text(f),blank);assert.equal(f.form().values.started_from,'');assert.equal(f.nodes.get('note-source-line').hidden,true);
 assert.equal(f.run('visitDrafts.has("visit-1")'),false,'a full undo leaves no unsaved draft');
 assert.match(f.bar(),/class="primary" data-note-same="all"/);assert.match(f.bar(),/Put back as it was\./);
 console.log('PASS Undo is retained with the draft and keeps anything edited afterwards');

 f=fixture();await f.settle();f.type({subjective:'My own history',plan:'My own plan'});
 await f.click({noteSame:'all'},[false]);
 assert.equal(f.asked[0].message,'Replace what you have written, or fill only the empty sections?');
 assert.equal(f.asked[0].options.confirmLabel,'Fill empty sections');assert.equal(f.asked[0].options.alternateLabel,'Replace what I wrote');assert.equal(f.asked[0].options.cancelLabel,'Cancel');
 assert.match(f.asked[0].options.detail,/^From your visit on .*2026\. You have written in Subjective and Plan\.$/);
 assert.deepEqual(text(f),{...blank,subjective:'My own history',plan:'My own plan'},'Cancel changes nothing');assert.equal(f.form().values.started_from,'');
 await f.click({noteSame:'all'},[true]);
 assert.deepEqual(text(f),{...earlier,subjective:'My own history',plan:'My own plan'},'the default fills only the empty sections');
 assert.deepEqual(f.from().sections,['objective','assessment','procedure']);
 await f.click({noteSame:'all'},['alternate']);
 assert.deepEqual(text(f),earlier,'Replace is an explicit second choice');assert.deepEqual(f.from().sections,sections);
 await f.click({noteUndo:''});assert.deepEqual(text(f),{...earlier,subjective:'My own history',plan:'My own plan'},'each step undoes separately');
 await f.click({noteUndo:''});assert.deepEqual(text(f),{...blank,subjective:'My own history',plan:'My own plan'});assert.equal(f.form().values.started_from,'');
 console.log('PASS written sections are never replaced without the explicit choice');

 f=fixture();await f.settle();
 await f.click({noteSame:'objective'});
 assert.deepEqual(text(f),{...blank,objective:'Earlier O'},'a section link brings in only that section');assert.deepEqual(f.from().sections,['objective']);
 f.type({procedure:'Today procedure'});
 await f.click({noteSame:'procedure'},[false]);
 assert.equal(f.asked[0].message,'Replace what you have written in Procedure?');assert.equal(f.asked[0].options.initialFocus,'cancel');
 assert.equal(f.form().values.procedure,'Today procedure');
 await f.click({noteSame:'procedure'},[true]);
 assert.equal(f.form().values.procedure,'Earlier procedure');assert.deepEqual(f.from().sections,['objective','procedure']);
 await f.click({noteSame:'objective'});assert.match(f.bar(),/This already matches the last visit\. Nothing was changed\./);
 f.type({subjective:'Mine',assessment:'Mine',plan:'Mine'});await f.click({noteSame:'all'},[true]);
 assert.match(f.bar(),/Every section already has text\. Nothing was changed\./);assert.equal(f.form().values.plan,'Mine');
 console.log('PASS each section has its own link with the same never-overwrite rule');

 // Sections the earlier note left empty are not offered and never blank out today's text.
 f=fixture({previous:source({same_clinician:false,clinician_name:'Dr. Peer <Synthetic>',note:{...earlier,procedure:'',assessment:'  '}})});await f.settle();
 assert.match(f.bar(),/From Dr\. Peer &lt;Synthetic&gt;’s visit on [^<]*2026</,'another clinician is named, safely escaped');
 assert.equal(f.nodes.get('note-same-procedure').hidden,true);assert.equal(f.nodes.get('note-same-assessment').hidden,true);assert.equal(f.nodes.get('note-same-plan').hidden,false);
 f.type({procedure:'Today procedure'});await f.click({noteSame:'all'});assert.equal(f.asked.length,0,'nothing written is at risk, so nothing is asked');
 assert.deepEqual(text(f),{subjective:'Earlier S',objective:'Earlier O',assessment:'',plan:'Earlier P',procedure:'Today procedure'});
 f=fixture({previous:source({same_clinician:false})});await f.settle();assert.match(f.bar(),/From another clinician’s visit on/);
 f=fixture({previous:null});await f.settle();
 assert.equal(f.bar(),'<span class="muted">No earlier signed note for this patient.</span>');
 for(const key of sections)assert.equal(f.nodes.get('note-same-'+key).hidden,true);
 await f.click({noteSame:'all'});assert.deepEqual(text(f),blank);
 f=fixture({previous:'fail'});await f.settle();assert.match(f.bar(),/The last note could not be checked\..*data-note-retry>Try again</);
 f.context.testPrevious=source();await f.click({noteRetry:''});assert.match(f.bar(),/data-note-same="all"/);assert.equal(f.requests.length,2);
 f=fixture({clinician:'someone-else',previous:source({clinician_id:'someone-else',clinician_name:'Dr. Assigned',same_clinician:true,own:false})});await f.settle();
 assert.deepEqual(f.requests.map(r=>r.path).sort(),['/api/v1/visits/visit-1/note-authorship','/api/v1/visits/visit-1/previous-note'],'anyone who may draft is offered the earlier note');
 assert.match(f.bar(),/data-note-same="all">Same as last visit<\/button><span class="muted">From Dr\. Assigned’s visit on /,'the assigned clinician’s earlier note is named as theirs, not as the covering writer’s');
 await f.click({noteSame:'all'});assert.deepEqual(text(f),earlier);
 for(const role of ['front_desk','read_only']){
  f=fixture({role,clinician:'someone-else'});await f.settle();
  assert.ok(!f.requests.some(r=>r.path.endsWith('/previous-note')),role+' is not offered the earlier note');assert.doesNotMatch(f.editor(),/note-previous|data-note-same|name="started_from"/);
  assert.doesNotMatch(f.editor(),/Procedure/,'a read-only viewer is not shown an empty Procedure');
 }
 console.log('PASS no earlier note, empty earlier sections, a covering writer and read-only viewers');

 f=fixture();await f.settle();await f.click({noteSame:'all'});f.type({plan:'Edited plan',procedure:'   '});await f.submit();
 let put=f.requests.find(r=>r.method==='PUT');
 assert.deepEqual(JSON.parse(JSON.stringify(put.body)),{subjective:'Earlier S',objective:'Earlier O',assessment:'Earlier A',plan:'Edited plan',started_from:{visit_id:'visit-0',version:3,sections}},'copied text is saved as ordinary text with its origin; a blank Procedure is left out');
 assert.equal(put.version,1);assert.equal(f.run('visitDrafts.has("visit-1")'),false,'the saved note leaves no unsaved draft');
 assert.doesNotMatch(f.bar()+f.run('String(visitNoteUndo.size)'),/data-note-undo|1/,'Undo ends when the note is saved');
 f.run('renderVisit(false)');await f.settle();
 assert.match(f.editor(),/Started from the visit on [^<]*2026\. Review every section before signing\./,'the line stays until signing');
 await f.click({action:'sign'},[true]);
 assert.ok(f.requests.some(r=>r.path.endsWith('/sign')),'a saved note with an origin can be signed');
 f=fixture();await f.settle();f.type({subjective:'S',objective:'O',assessment:'A',plan:'P',procedure:'Synthetic procedure text'});await f.submit();
 put=f.requests.find(r=>r.method==='PUT');assert.deepEqual(JSON.parse(JSON.stringify(put.body)),{subjective:'S',objective:'O',assessment:'A',plan:'P',procedure:'Synthetic procedure text'},'a note written from scratch carries no origin');
 // An empty note is never sent: the reason shows beside the buttons, not in the banner.
 const emptyDraft=fixture({previous:null});await emptyDraft.settle();emptyDraft.requests.length=0;
 await emptyDraft.submit();assert.equal(emptyDraft.requests.length,0,'an empty note sends nothing');
 assert.equal(emptyDraft.nodes.get('note-message').hidden,false);assert.equal(emptyDraft.nodes.get('note-message').textContent,'Write something in the note before saving.');
 assert.equal(emptyDraft.requests.some(r=>r.method==='PUT'),false,'an empty note is not sent');
 assert.match(emptyDraft.editor(),/<div id="note-message" class="note-message muted" role="status" hidden><\/div><div class="actions"><button type="submit">Save note<\/button>/,'the empty message line sits inside the note form, right beside Save note and Sign encounter note');
 assert.equal(emptyDraft.nodes.get('notice').hidden,true,'the reason shows next to the buttons, not in the banner out of view');
 // A draft saves with any one section filled.
 emptyDraft.type({procedure:'Procedure only'});await emptyDraft.submit();
 assert.equal(emptyDraft.requests.filter(r=>r.method==='PUT').length,1,'a note with only Procedure filled is a draft worth saving');assert.equal(emptyDraft.nodes.get('note-message').textContent,'Note saved.');
 emptyDraft.type({procedure:''});
 emptyDraft.type({plan:'Plan only'});await emptyDraft.submit();
 put=emptyDraft.requests.filter(r=>r.method==='PUT').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(put.body)),{subjective:'',objective:'',assessment:'',plan:'Plan only'},'Save note keeps a draft with only Plan filled; empty sections are sent as empty');
 assert.equal(emptyDraft.nodes.get('note-message').textContent,'Note saved.','a saved note is confirmed beside the buttons');
 assert.equal(emptyDraft.nodes.get('note-message').hidden,false);
 // Signing refuses quietly-wrong sections: no question is asked, the missing fields are named and the first one takes the caret.
 let focused=[];for(const key of ['subjective','objective','assessment'])emptyDraft.form().elements[key].focus=()=>focused.push(key);
 await emptyDraft.click({action:'sign'});
 assert.equal(emptyDraft.asked.length,0,'the sign question never opens while sections are missing');
 assert.equal(emptyDraft.nodes.get('note-message').textContent,'Fill in Subjective, Objective and Assessment before signing.');
 assert.equal(emptyDraft.nodes.get('note-message').hidden,false);assert.deepEqual(focused,['subjective'],'the first missing section takes the caret');
 assert.equal(emptyDraft.requests.some(r=>r.path.endsWith('/sign')),false);
 emptyDraft.type({subjective:'S',objective:'O',assessment:'A'});await emptyDraft.submit();
 assert.equal(emptyDraft.nodes.get('note-message').textContent,'Note saved.');
 await emptyDraft.click({action:'sign'},[true]);assert.ok(emptyDraft.requests.some(r=>r.path.endsWith('/sign')),'with all four sections filled the usual sign question opens and signs');
 console.log('PASS an empty note is refused with a word beside the buttons; any one section saves; signing names what is missing and focuses it');

 // A draft saved before the Procedure section existed still signs without a re-save.
 f=fixture({note:{subjective:'S',objective:'O',assessment:'A',plan:'P'},previous:null});await f.settle();
 assert.equal(f.run('visitDrafts.has("visit-1")'),false);f.run('captureVisitDrafts()');assert.equal(f.run('visitDrafts.has("visit-1")'),false,'an older saved note is not mistaken for an unsaved edit');
 await f.click({action:'sign'},[true]);assert.ok(f.requests.some(r=>r.path.endsWith('/sign')));
 f=fixture({note:{subjective:'S',objective:'O',assessment:'A',plan:'P'},previous:null});await f.settle();f.type({procedure:'Unsaved procedure'});
 await f.click({action:'sign'});assert.equal(f.nodes.get('notice').textContent,'Save your current note before signing.');assert.ok(!f.requests.some(r=>r.path.endsWith('/sign')));
 console.log('PASS saving sends Procedure and the origin; older drafts still sign; unsaved Procedure blocks signing');

 const signed=(noteValue)=>{const s=fixture({note:noteValue});s.requests.length=0;s.run(clearVisitNoteSessionCall);s.run("activeVisit={...activeVisit,status:'signed',signed_at:'2026-11-11T13:00:00Z'};workspace.visits=[activeVisit];renderVisit(false)");return s;};
 f=signed({subjective:'Frozen S',objective:'Frozen O',assessment:'Frozen A',plan:'Frozen P'});await f.settle();note=f.noteForm();
 assert.equal([...note.matchAll(/readonly/g)].length,4);assert.doesNotMatch(f.editor(),/Procedure|note-source|Started from|note-previous|data-note-same|started_from/,'an older signed note renders exactly as before');
 f=signed({subjective:'Frozen S',objective:'Frozen O',assessment:'Frozen A',plan:'Frozen P',procedure:'Frozen <procedure>',started_from:{visit_id:'visit-0',version:3,sections:['plan','procedure'],visit_date:'2026-11-04T15:00:00Z'}});await f.settle();note=f.noteForm();
 assert.equal([...note.matchAll(/readonly/g)].length,5);
 assert.match(note,/name="plan" maxlength="10000" readonly>Frozen P<\/textarea><\/label><\/div><div class="note-section note-procedure"><label>Procedure<textarea name="procedure" maxlength="10000" readonly>Frozen &lt;procedure&gt;<\/textarea>/,'signed Procedure is read-only, below Plan');
 assert.match(f.editor(),/<p id="note-source-line" class="note-source muted">Started from the visit on [^<]*2026\.<\/p>/,'a reviewer can see the signed note was started from an earlier one');
 assert.doesNotMatch(f.editor(),/Review every section|note-previous|data-note-same|name="started_from"|placeholder="Procedure performed/);
 assert.ok(!f.requests.some(r=>r.path.endsWith('/previous-note')),'a signed note never asks for the earlier note');
 console.log('PASS signed view shows Procedure only when recorded and keeps older notes unchanged');

 const rules=style.split('\n').filter(line=>/^\.note-(section|previous|source)/.test(line)).join('\n');
 assert.ok(rules.includes('.note-previous{')&&rules.includes('.note-source{'));
 assert.doesNotMatch(rules,/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i,'the new note styles use theme variables only, so dark mode follows the theme');
 assert.match(rules,/background:var\(--surface-soft\);color:var\(--ink\)/);
 assert.doesNotMatch(module_,/style=|#[0-9a-f]{6}\b/i);assert.doesNotMatch(module_,/localStorage|sessionStorage/,'earlier note text is never stored in the browser');
 console.log('PASS dark mode uses theme variables only');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
