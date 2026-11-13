// SPDX-License-Identifier: AGPL-3.0-only
// Who may write, sign and correct a visit note, as the editor shows it to each role.
// Synthetic DOM fixtures exercise the real handlers; no browser or network.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const web=path.join(__dirname,'../web'),read=name=>fs.readFileSync(path.join(web,name),'utf8');
const app=read('app.js'),module_=read('visit-note.js'),checkout=read('checkout.js'),portal=read('portal-staff.js');
const decode=value=>String(value||'').replace(/&(amp|lt|gt|quot|#39);/g,(_,key)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"})[key]);
const people={assigned:'Dr. Avery Assigned',covering:'Dr. Casey Covering',owner:'Dr. Olive Owner',assistant:'Morgan Assistant',nurse:'Nico Nurse',desk:'Frankie Desk'};
const soap={subjective:'S',objective:'O',assessment:'A',plan:'P'};
const savedBy=(id,name=people[id],extra={})=>({id,name,at:'2026-11-10T15:05:00Z',...extra});
function fixture({user='covering',role='clinician',delegated=false,assigned='assigned',note=null,status='in_progress',signedBy=null,amendments=[],policy=null,display=people[user]}={}){
 const nodes=new Map(),listeners=new Map(),requests=[],asked=[];let answers=[];
 function node(id){
  if(nodes.has(id))return nodes.get(id);
  let html='';
  const n={id,hidden:false,disabled:false,isConnected:true,dataset:{},value:'',textContent:'',className:'',classList:{add(){},remove(){},contains:()=>false,toggle(){}},
   setAttribute(){},removeAttribute(){},addEventListener(){},replaceChildren(){this.innerHTML='';},querySelector(){return null;},focus(){},scrollIntoView(){}};
  Object.defineProperty(n,'innerHTML',{get:()=>html,set(value){html=value;if(id==='visit-editor')parseEditor(value);}});
  nodes.set(id,n);return n;
 }
 const editorOwned=id=>id.startsWith('note-')||id.startsWith('amendment-')||id.endsWith('-form');
 function parseEditor(html){
  for(const [id,old] of [...nodes])if(id!=='visit-editor'&&editorOwned(id)){old.isConnected=false;nodes.delete(id);}
  for(const [,attributes,id,text] of html.matchAll(/<(?:div|p|button|span)\b([^>]*\bid="([^"]+)"[^>]*)>([^<]*)/g)){const n=node(id);n.hidden=/\shidden(?=[\s>]|$)/.test(attributes);n.textContent=decode(text);}
  for(const match of html.matchAll(/<form id="([^"]+)"([^>]*)>([\s\S]*?)<\/form>/g)){
   const [,id,attributes,body]=match,form=node(id);form.values={};form.elements={};
   for(const [,key,value]of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g))form.dataset[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=decode(value);
   for(const input of body.matchAll(/<(input|textarea)\b([^>]*\bname="([^"]+)"[^>]*)>([^<]*)/g)){
    const [,tag,attrs,name,text]=input;form.values[name]=tag==='textarea'?decode(text):decode(attrs.match(/value="([^"]*)"/)?.[1]);
    form.elements[name]={get value(){return form.values[name];},set value(value){form.values[name]=value;},focus(){}};
   }
  }
 }
 const known=id=>id==='visit-editor'||!editorOwned(id);
 const context=vm.createContext({console,Date,Intl,URL,URLSearchParams,TextEncoder,crypto:{randomUUID:()=>'synthetic-request'},location:{search:'',hash:'',pathname:'/'},
  FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){yield*Object.entries(this.form.values||{});}},
  document:{documentElement:{classList:{add(){},remove(){}}},getElementById:id=>known(id)?node(id):nodes.get(id)||null,querySelectorAll:()=>[],addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(callback);}},
  window:{scrollTo(){},addEventListener(){}},fetch(){throw new Error('Unexpected network request');},billingWrite:()=>true,billingCan:()=>true,canDocument:()=>true,
  confirmAction:async(message,options)=>{asked.push({message,options});if(!answers.length)throw new Error('Unexpected question: '+message);return answers.shift();},
  localStorage:{setItem(){throw new Error('PHI must not be persisted');}},sessionStorage:{setItem(){throw new Error('PHI must not be persisted');}}
 });
 const run=code=>vm.runInContext(code,context);run(app);run(module_);
 Object.assign(context,{testRequests:requests,testPeople:people,testServer:{},testPolicy:policy});
 // The synthetic server: it stores the note like the real one and refuses a stale version.
 run(`api=async(path,method='GET',body,version)=>{testRequests.push({path,method,body,version});
  const conflict=()=>Object.assign(new Error('visit changed; reload before saving'),{status:409,code:'conflict'});
  if(path.endsWith('/previous-note'))return {source:null};
  if(path.endsWith('/note-authorship'))return {assigned:{id:activeVisit.clinician_id,name:testPeople[activeVisit.clinician_id]||''},signed:activeVisit.signed_by?{id:activeVisit.signed_by,name:testPeople[activeVisit.signed_by]||'',at:activeVisit.signed_at}:null,amendments:workspace.amendments.map(a=>({id:a.id,author_id:a.author_id,author_name:testPeople[a.author_id]||'',created_at:a.created_at}))};
  if(method==='GET'&&path==='/api/v1/visits/visit-1')return testServer.current;
  if(path.endsWith('/note')){const stored=testServer.current||activeVisit;if(version!==stored.version)throw conflict();
   testServer.current={...stored,version:stored.version+1,note:{...body,saved_by:{id:me.user_id,name:me.display_name,at:'2026-11-10T16:00:00Z'}}};return testServer.current;}
  if(path.endsWith('/sign'))return {...activeVisit,status:'signed',signed_by:me.user_id,signed_at:'2026-11-10T17:00:00Z',version:activeVisit.version+1};throw new Error('Unexpected request '+path);};
 selectPatient=async()=>{};setEncounterSection=()=>{};chartAreaEnabled=()=>false;
 if(testPolicy)workspaceResourceAllowed=(resource,action='view')=>testPolicy[resource]?.[action]===true;
 me={tenant_id:'tenant-1',user_id:${JSON.stringify(user)},role:${JSON.stringify(role)},display_name:${JSON.stringify(display)},delegated:${JSON.stringify(delegated)}};selected='patient-1';
 workspace={appointments:[{id:'appointment-1',title:'Synthetic visit',starts_at:'2026-11-10T15:00:00Z'}],visits:[],amendments:${JSON.stringify(amendments)},clinical:{items:[],reviews:[]},labs:{orders:[],reports:[],acknowledgments:[]},billing:{accounts:[]}};
 activeVisit={id:'visit-1',patient_id:selected,appointment_id:'appointment-1',clinician_id:${JSON.stringify(assigned)},status:${JSON.stringify(status)},version:4,note:${JSON.stringify(note)},vitals:null,signed_by:${JSON.stringify(signedBy)},signed_at:${JSON.stringify(signedBy?'2026-11-10T17:00:00Z':null)}};
 workspace.visits=[activeVisit];renderVisit(false);`);
 const settle=async()=>{for(let i=0;i<12;i++)await new Promise(done=>setImmediate(done));};
 const form=()=>nodes.get('note-form');
 function type(values){Object.assign(form().values,values);for(const callback of listeners.get('input')||[])callback({target:{closest:selector=>selector.includes('#note-form')?form():null}});}
 async function click(dataset,reply=[]){answers=[...reply];const button={id:'',type:'button',dataset,closest:()=>null,hasAttribute:()=>false};for(const callback of listeners.get('click')||[])callback({target:{closest:()=>button}});await settle();assert.equal(answers.length,0,'every prepared answer was used');}
 async function submit(){for(const callback of listeners.get('submit')||[])callback({target:form(),preventDefault(){}});await settle();}
 const editor=()=>nodes.get('visit-editor').innerHTML,line=id=>{const n=nodes.get(id);return n&&!n.hidden?n.textContent:'';};
 return {run,context,nodes,requests,asked,settle,form,type,click,submit,editor,line,notice:()=>node('notice').textContent,server:context.testServer};
}
// Starting an encounter keeps its own rule and wording; only the note rule changed.
const oldRule=/Documentation is read-only|Only the assigned clinician can (?:save|sign|amend|append)|assigned clinician must publish|assigned clinician’s SOAP note/;
const count=(f,method,end)=>f.requests.filter(r=>r.method===method&&r.path.endsWith(end)).length;
async function main(){
 // A colleague's unsigned visit, last saved by the medical assistant.
 const draft={...soap,saved_by:savedBy('assistant')};
 for(const [user,role] of [['covering','clinician'],['owner','owner']]){
  const f=fixture({user,role,note:draft});await f.settle();
  assert.match(f.editor(),/<button type="submit">Save note<\/button><button class="primary" type="button" data-action="sign">Sign encounter note<\/button>/,role);
  assert.doesNotMatch(f.editor(),/ readonly|You can read this note|You can draft this note/,role);
  assert.match(f.line('note-authorship'),/^Drafting for Dr\. Avery Assigned · Last saved by Morgan Assistant, [^·]*2026/,role);
  assert.equal(count(f,'GET','/previous-note'),1,role+' is offered the earlier note');
 }
 for(const [user,role] of [['nurse','nurse'],['assistant','medical_assistant']]){
  const f=fixture({user,role,note:draft});await f.settle();
  assert.match(f.editor(),/<button type="submit">Save note<\/button><span id="note-sign-help" class="muted">You can draft this note\. A clinician signs it\.<\/span>/,role);
  assert.doesNotMatch(f.editor(),/data-action="sign"| readonly|You can read this note|amendment-form/,role);
  assert.match(f.line('note-authorship'),/^Drafting for Dr\. Avery Assigned · Last saved by Morgan Assistant, /,role);
  // A forged sign click is refused before any request leaves the page.
  await f.click({action:'sign'});assert.equal(f.notice(),'A clinician must sign this note.');assert.equal(count(f,'POST','/sign'),0,role);
 }
 for(const [user,role] of [['desk','front_desk'],['desk','read_only']]){
  const f=fixture({user,role,note:draft});await f.settle();
  assert.match(f.editor(),/<p id="note-read-only" class="muted">You can read this note\. Clinical staff write it and a clinician signs it\.<\/p>/,role);
  assert.doesNotMatch(f.editor(),/>Save note<|data-action="sign"|You can draft this note|note-previous|data-note-same/,role);
  assert.equal([...f.editor().matchAll(/<textarea name="[a-z]+"[^>]* readonly>/g)].length,4,role+' reads every section');
  assert.match(f.line('note-authorship'),/^Last saved by Morgan Assistant, /,role+' sees who wrote it but is not drafting');
  assert.equal(count(f,'GET','/previous-note'),0,role);
 }
 console.log('PASS clinicians and the owner write and sign a colleague’s note; nurse and medical assistant draft only; front desk and read-only staff read');

 let f=fixture({user:'support',role:'owner',delegated:true,display:'platform_admin:synthetic',note:draft});await f.settle();
 assert.match(f.editor(),/<button type="submit">Save note<\/button><span id="note-sign-help" class="muted">You can draft this note\. A clinician at the practice must sign it\.<\/span>/);
 assert.doesNotMatch(f.editor(),/data-action="sign"|You can read this note/);
 await f.click({action:'sign'});assert.equal(count(f,'POST','/sign'),0,'a support session never signs');
 f=fixture({user:'support',role:'owner',delegated:true,display:'platform_admin:synthetic',note:{...soap,saved_by:savedBy('support','Support staff',{support:true})},status:'signed',signedBy:'assigned'});await f.settle();
 assert.doesNotMatch(f.editor(),/amendment-form|data-action="focus-amendment"/);
 assert.match(f.editor(),/A clinician at the practice must sign any correction\./);
 assert.match(f.line('note-authorship'),/^Last saved by Support staff, /,'what support drafted stays named as support');
 console.log('PASS a support session drafts, is told a clinician must sign, and is never offered signing or corrections');

 f=fixture({user:'assistant',role:'medical_assistant',note:draft,policy:{clinical:{view:true,create:true,edit:false,delete:false}}});await f.settle();
 assert.match(f.editor(),/You can read this note\. Clinical staff write it and a clinician signs it\./);assert.doesNotMatch(f.editor(),/>Save note</);
 f=fixture({user:'covering',role:'clinician',note:draft,policy:{clinical:{view:true,create:false,edit:false,delete:false}}});await f.settle();
 assert.doesNotMatch(f.editor(),/>Save note<|data-action="sign"/);
 console.log('PASS a custom access policy without clinical edit removes drafting and signing');

 // The assigned clinician's own visit: nothing extra is asked for or shown.
 f=fixture({user:'assigned',role:'clinician',note:{...soap,saved_by:savedBy('assigned')}});await f.settle();
 assert.equal(f.line('note-authorship').replace(/, .*/,''),'Last saved by Dr. Avery Assigned');assert.doesNotMatch(f.line('note-authorship'),/Drafting for/);
 assert.equal(count(f,'GET','/note-authorship'),0);
 await f.click({action:'sign'},[true]);
 assert.equal(f.asked[0].options.title,'Sign encounter note?');assert.equal(count(f,'POST','/sign'),1);
 f=fixture({user:'assigned',role:'clinician',note:null});await f.settle();assert.equal(f.line('note-authorship'),'','a note nobody has saved names nobody');
 console.log('PASS the assigned clinician’s own visit keeps its usual editor and signature question');

 // Covering signature: one clear question, then the signature is the covering clinician's own.
 f=fixture({user:'covering',role:'clinician',note:draft});await f.settle();
 await f.click({action:'sign'},[false]);
 assert.equal(f.asked.length,1);
 assert.equal(f.asked[0].options.title,'Sign as yourself for Dr. Avery Assigned’s visit?');
 assert.equal(f.asked[0].options.confirmLabel,'Sign');assert.equal(f.asked[0].options.cancelLabel,'Cancel');
 assert.equal(f.asked[0].message,'Signing locks the note and records you as the signer. The visit stays assigned to Dr. Avery Assigned. Check the rendering provider on the claim if you saw the patient.');
 assert.equal(count(f,'POST','/sign'),0,'Cancel signs nothing');
 await f.click({action:'sign'},[true]);
 const signRequest=f.requests.find(r=>r.path.endsWith('/sign'));assert.equal(signRequest.version,4);assert.equal(signRequest.body,undefined,'signing never reassigns the visit');
 f=fixture({user:'covering',role:'clinician',note:draft});await f.settle();f.type({plan:'Unsaved plan'});
 await f.click({action:'sign'});assert.equal(f.notice(),'Save your current note before signing.');assert.equal(f.asked.length,0);
 console.log('PASS a covering clinician is asked once, by name, and Cancel signs nothing');

 // Saving updates "Last saved by" to the writer.
 f=fixture({user:'covering',role:'clinician',note:draft});await f.settle();f.type({plan:'Covering plan'});await f.submit();
 assert.equal(f.notice(),'Note saved.');assert.equal(f.requests.find(r=>r.method==='PUT').version,4);
 assert.match(f.line('note-authorship'),/^Drafting for Dr\. Avery Assigned · Last saved by Dr\. Casey Covering, /);
 assert.equal(f.run('visitDrafts.has("visit-1")'),false);
 console.log('PASS “Last saved by” follows each save');

 // Someone saved vitals meanwhile: the note text is as it was opened, so the save goes through.
 f=fixture({user:'covering',role:'clinician',note:draft});await f.settle();f.type({plan:'My plan'});
 f.server.current={...f.run('activeVisit'),version:5,vitals:{heart_rate_bpm:70}};await f.submit();
 assert.deepEqual(f.requests.filter(r=>r.method==='PUT').map(r=>r.version),[4,5]);assert.equal(f.notice(),'Note saved.');
 assert.equal(f.run('activeVisit.note.plan'),'My plan');assert.equal(f.run('activeVisit.vitals.heart_rate_bpm'),70,'the colleague’s vitals are kept');
 console.log('PASS a colleague saving vitals or intake does not block the note being written');

 // Someone saved the note itself meanwhile: nothing is overwritten and nothing typed is lost.
 f=fixture({user:'covering',role:'clinician',note:draft});await f.settle();f.type({plan:'My plan'});
 f.server.current={...f.run('activeVisit'),version:5,note:{...soap,plan:'Assistant <plan>',saved_by:savedBy('assistant')}};await f.submit();
 assert.equal(f.notice(),'Morgan Assistant saved this note while you were writing. Nothing was overwritten and your text is still here.');
 assert.equal(count(f,'PUT','/note'),1,'the refused save is not retried over a colleague’s text');
 assert.equal(f.form().values.plan,'My plan');assert.equal(f.form().dataset.version,'4');assert.equal(f.server.current.note.plan,'Assistant <plan>');
 const status=f.nodes.get('visit-draft-status');
 assert.match(status.textContent,/Morgan Assistant saved this note on [^.]*2026[^.]* while you were writing\. Nothing was overwritten\. Your text is still here and has not been saved\./);
 const conflict=f.nodes.get('note-conflict');assert.equal(conflict.hidden,false,'the choice is shown with the note');
 assert.match(conflict.innerHTML,/^<p>Morgan Assistant saved this note on [^<]* while you were writing\. Nothing was overwritten\. Your text is still here and has not been saved\.<\/p><div class="actions"><button type="button" data-action="show-saved-note" aria-controls="note-saved-copy">See the saved note<\/button><button type="button" data-action="keep-note-draft">Keep my text<\/button><button type="button" data-action="discard-visit-draft">Use the saved note<\/button><\/div>$/);
 assert.match(f.line('note-authorship'),/Last saved by Morgan Assistant, /,'the line under the heading names the colleague who saved');
 await f.click({action:'show-saved-note'});
 assert.match(f.nodes.get('note-saved-copy').innerHTML,/<p class="muted">Plan<\/p><p class="note-text">Assistant &lt;plan&gt;<\/p>/);assert.equal(f.nodes.get('note-saved-copy').hidden,false);
 await f.submit();assert.equal(count(f,'PUT','/note'),2);assert.equal(f.server.current.note.plan,'Assistant <plan>','saving again without choosing still overwrites nothing');
 await f.click({action:'keep-note-draft'});assert.equal(f.form().dataset.version,'5');assert.doesNotMatch(status.textContent,/saved this note/);assert.equal(conflict.hidden,true);assert.equal(conflict.innerHTML,'');
 await f.submit();assert.equal(f.notice(),'Note saved.');assert.equal(f.server.current.note.plan,'My plan');assert.equal(f.server.current.note.saved_by.name,'Dr. Casey Covering');
 // Choosing the saved note instead discards only the text in this tab.
 f=fixture({user:'covering',role:'clinician',note:draft});await f.settle();f.type({plan:'My plan'});
 f.server.current={...f.run('activeVisit'),version:5,note:{...soap,plan:'Assistant plan',saved_by:savedBy('assistant')}};await f.submit();
 await f.click({action:'discard-visit-draft'},[true]);assert.equal(f.form().values.plan,'Assistant plan');assert.equal(f.form().dataset.version,'5');assert.equal(f.run('visitDrafts.has("visit-1")'),false);
 // Signed meanwhile: the text stays on screen and is not saved into the signed record.
 f=fixture({user:'assistant',role:'medical_assistant',note:draft});await f.settle();f.type({plan:'Late plan'});
 f.server.current={...f.run('activeVisit'),version:5,status:'signed',signed_by:'assigned',signed_at:'2026-11-10T17:00:00Z'};await f.submit();
 assert.equal(f.notice(),'This note was signed while you were writing, so your text was not saved. Copy anything you still need, then reload the patient.');
 assert.equal(f.form().values.plan,'Late plan');assert.equal(count(f,'PUT','/note'),1);
 console.log('PASS two writers: the second save is refused, both texts stay visible, and replacing a colleague’s text is an explicit choice');

 // Signed notes name the signer; a covering signature also names the assigned clinician.
 const amendments=[{id:'amendment-1',visit_id:'visit-1',author_id:'owner',reason:'Fix',text:'Corrected',created_at:'2026-11-11T10:00:00Z'}];
 f=fixture({user:'desk',role:'front_desk',note:draft,status:'signed',signedBy:'covering',amendments});await f.settle();
 assert.match(f.line('note-signed-by'),/^Signed by Dr\. Casey Covering, [^.]*2026[^.]*\. Visit assigned to Dr\. Avery Assigned\.$/);
 assert.equal(f.line('amendment-author-amendment-1'),' by Dr. Olive Owner');
 assert.match(f.editor(),/The original SOAP note and vitals cannot be overwritten\. A clinician can add a correction\.<\/div>/);
 assert.doesNotMatch(f.editor(),/amendment-form|>Save note<|data-action="sign"|You can read this note/);
 f=fixture({user:'desk',role:'front_desk',note:draft,status:'signed',signedBy:'assigned'});await f.settle();
 assert.match(f.line('note-signed-by'),/^Signed by Dr\. Avery Assigned, [^.]*2026[^.]*\.$/,'the assigned clinician’s own signature needs no second name');
 for(const [user,role,signedBy] of [['covering','clinician','covering'],['assigned','clinician','covering'],['owner','owner','assigned']]){
  f=fixture({user,role,note:draft,status:'signed',signedBy,amendments});await f.settle();
  assert.ok(f.nodes.get('amendment-form'),`${user} may add a correction`);assert.match(f.editor(),/data-action="focus-amendment"/);
 }
 for(const [user,role] of [['nurse','nurse'],['assistant','medical_assistant']]){
  f=fixture({user,role,note:draft,status:'signed',signedBy:'assigned'});await f.settle();
  assert.equal(f.nodes.get('amendment-form'),undefined,role);assert.match(f.editor(),/A clinician can add a correction\./,role);
 }
 f=fixture({user:'assigned',role:'clinician',note:{...soap,saved_by:savedBy('assigned')},status:'signed',signedBy:'assigned'});await f.settle();
 assert.match(f.line('note-signed-by'),/^Signed by Dr\. Avery Assigned, /);assert.equal(count(f,'GET','/note-authorship'),0,'your own signed note asks for no names');
 console.log('PASS signed notes show “Signed by”, the assigned clinician when different, and each correction’s author');

 for(const name of fs.readdirSync(web).filter(file=>/\.(js|html)$/.test(file)))assert.doesNotMatch(read(name),oldRule,name+' no longer states the old rule');
 assert.match(checkout,/canAuthor=\['owner','clinician'\]\.includes\(me\.role\)&&!me\.delegated,/,'whoever may sign releases the patient summary');
 assert.match(portal,/<p>A clinician must publish or withdraw this summary\.<\/p>/);
 assert.match(checkout,/avs\.snapshot\.visit\?\.signed_by_label\?`Seen by \$\{avs\.snapshot\.visit\.signed_by_label\}`:avs\.snapshot\.visit\?\.clinician_label/,'a summary for a visit someone else signed says who saw the patient');
 assert.match(app,/function canRecordVisitVitals\(v\)\{[^}]*\(v\.clinician_id===me\.user_id\|\|!me\?\.delegated\)/,'a covering clinician records vitals; a support session does not');
 console.log('PASS no screen still says only the assigned clinician may write, sign or amend');
}
main().catch(error=>{console.error(error);process.exit(1);});
