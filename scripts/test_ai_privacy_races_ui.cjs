// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function load(context,file,names){
 const source=fs.readFileSync(file,'utf8');
 for(const name of names){
  const match=new RegExp(`^(?:async )?function ${name}\\([^\\n]*`,'m').exec(source);assert.ok(match,name);
  const end=match[0].endsWith('}')?match.index+match[0].length:source.indexOf('\n}',match.index)+2;
  vm.runInContext(source.slice(match.index,end),context);
 }
}
const preview={id:'preview-1',provider:'erebine',model:'synthetic',requires_approval:true,instruction:'sanitized instruction',source_text:'sanitized source'};
function form(id='dispatch-1'){return {dataset:{id,version:'1'},elements:{reason:{value:''},privacy_approved:{checked:true}},values:{source_text:'original synthetic source',instruction:'synthetic instruction'}};}
class FormData{constructor(form){this.form=form;}get(name){return this.form.elements[name]?.value;}[Symbol.iterator](){return Object.entries(this.form.values)[Symbol.iterator]();}}
function studio(){
 const nodes={tools:{innerHTML:'current Studio'},'studio-dispatch-action':form()},calls=[],renders=[];
 let reply=()=>Promise.resolve({items:[]});
 const context=vm.createContext({console,Set,JSON,Number,String,Promise,FormData,encodeURIComponent,me:{id:'owner'},studioView:'runs',studioPrivacyReview:null,studioPrivacyRevision:0,studioPrivacyBusy:false,studioSelectedDispatch:{dispatch:{id:'dispatch-1',version:1,status:'pending_review',kind:'ai_extract_draft'}},studioAiKinds:new Set(['ai_extract_draft']),sunPrivacyValid:()=>true,studioPrivacyFor:()=>null,studioRuns:[],studioDispatches:[],$:id=>nodes[id]||null,api:async(...args)=>{calls.push(args);return reply(...args);},notice(){},studioRender(){renders.push(true);nodes['studio-dispatch-action']=form();nodes.tools.innerHTML='rendered Studio';}});
 load(context,'web/workflow-studio.js',['clearStudioPrivacyReview','studioPreparePrivacy','studioDispatchAction']);
 return {context,nodes,calls,renders,setReply:next=>{reply=next;},run:code=>vm.runInContext(code,context)};
}
function integrations(){
 const nodes={'ai-generate-form':form(),'ai-privacy-preview':{innerHTML:''}},calls=[],renders=[];
 let reply=()=>Promise.resolve({items:[]});
 const context=vm.createContext({console,JSON,Object,Promise,crypto:{randomUUID:()=> 'request-1'},me:{id:'owner'},aiPrivacyReview:null,aiPrivacyRevision:0,aiPrivacyBusy:false,aiReviewState:{},$:id=>nodes[id]||null,aiPrivacyRequest:value=>({...value.values}),sunPrivacyValid:()=>true,sunPrivacyPreviewMarkup:()=> 'safe preview',api:async(...args)=>{calls.push(args);return reply(...args);},notice(){},renderAiReview(){renders.push(true);nodes['ai-generate-form']=form();}});
 load(context,'web/integrations.js',['clearAiPrivacyReview','aiPreparePrivacy','aiExecutePrivacy']);
 return {context,nodes,calls,renders,setReply:next=>{reply=next;},run:code=>vm.runInContext(code,context)};
}
function sun(){
 const nodes={'sun-panel':{hidden:false},'sun-privacy-approved':{checked:true},'sun-execute':{},'sun-send':{},'sun-answer':{textContent:'',dataset:{}}},spoken=[];
 const request=deferred(),account={id:'owner'};
 const context=vm.createContext({console,crypto:{randomUUID:()=> 'request-1'},me:account,sunGeneration:0,sunPreviewRevision:0,sunBusy:false,sunAnswerContext:null,signature:'original',sunPrivacyReview:{account,generation:0,signature:'original',preview,body:{source_text:'synthetic original'}},$:id=>nodes[id]||null,sunRequestSignature:()=>context.signature,sunPrivacyValid:()=>true,stopSunListening(){},sunStatus(){},sunInvalidatePrivacyReview(){context.sunPreviewRevision++;context.sunPrivacyReview=null;},sunSpeak:text=>spoken.push(text),api:()=>request.promise});
 load(context,'web/sun.js',['sunCollapseSettings','sunExecute']);
 return {context,nodes,spoken,request,run:code=>vm.runInContext(code,context)};
}
(async()=>{
 let h=studio(),request=deferred();h.setReply(()=>request.promise);
 let pending=h.run("studioPreparePrivacy('dispatch-1')");h.nodes['studio-dispatch-action'].elements.reason.value='Note typed while preparing';request.resolve(preview);await pending;
 assert.equal(h.renders.length,1);assert.equal(h.nodes['studio-dispatch-action'].elements.reason.value,'Note typed while preparing');assert.equal(h.context.studioPrivacyBusy,false);

 h=studio();request=deferred();h.setReply(()=>request.promise);pending=h.run("studioPreparePrivacy('dispatch-1')");delete h.nodes['studio-dispatch-action'];h.nodes.tools.innerHTML='Different workspace';request.resolve(preview);await pending;
 assert.equal(h.renders.length,0);assert.equal(h.nodes.tools.innerHTML,'Different workspace');assert.equal(h.context.studioPrivacyBusy,false);

 h=studio();request=deferred();h.setReply(()=>request.promise);h.context.testForm=h.nodes['studio-dispatch-action'];h.context.testForm.elements.reason.value='Reviewed';pending=h.run("studioDispatchAction(testForm,'reject')");delete h.nodes['studio-dispatch-action'];request.resolve({});await pending;
 assert.equal(h.renders.length,0);assert.equal(h.calls.length,1,'leaving Studio skips late refresh requests');

 h=studio();request=deferred();h.setReply(()=>request.promise);h.context.testForm=h.nodes['studio-dispatch-action'];h.context.testForm.elements.reason.value='Reviewed';pending=h.run("studioDispatchAction(testForm,'reject')");h.context.testForm.elements.reason.value='New unsaved note';request.resolve({});await pending;
 assert.equal(h.renders.length,0);assert.equal(h.context.testForm.elements.reason.value,'New unsaved note');

 h=integrations();const oldRequest=deferred(),newRequest=deferred();let count=0;h.setReply(()=>++count===1?oldRequest.promise:newRequest.promise);h.context.testForm=h.nodes['ai-generate-form'];const oldPending=h.run('aiPreparePrivacy(testForm)');h.run('clearAiPrivacyReview()');h.context.testForm.values.source_text='new source';const newPending=h.run('aiPreparePrivacy(testForm)'),newBusy=h.context.aiPrivacyBusy;oldRequest.resolve(preview);await oldPending;
 assert.equal(h.context.aiPrivacyBusy,newBusy,'old preview completion cannot unlock a newer request');assert.equal(h.context.aiPrivacyReview,null);newRequest.resolve({...preview,id:'preview-2'});await newPending;assert.equal(h.context.aiPrivacyReview.body.source_text,'new source');assert.equal(h.context.aiPrivacyBusy,false);

 h=integrations();request=deferred();h.setReply(()=>request.promise);h.context.aiPrivacyReview={account:h.context.me,form:h.nodes['ai-generate-form'],body:{...h.nodes['ai-generate-form'].values},preview};pending=h.run('aiExecutePrivacy()');h.run('clearAiPrivacyReview()');const newer={id:'new review'};h.context.aiPrivacyReview=newer;h.nodes['ai-generate-form'].values.source_text='edited while running';request.resolve({});await pending;
 assert.equal(h.renders.length,0);assert.equal(h.calls.length,1);assert.equal(h.context.aiPrivacyReview,newer,'late generation cannot clear a new review');

 h=integrations();request=deferred();h.setReply(()=>request.promise);h.context.aiPrivacyReview={account:h.context.me,form:h.nodes['ai-generate-form'],body:{...h.nodes['ai-generate-form'].values},preview};pending=h.run('aiExecutePrivacy()');h.context.me={id:'other-session'};h.run('clearAiPrivacyReview()');request.resolve({});await pending;
 assert.equal(h.renders.length,0);assert.equal(h.context.aiPrivacyBusy,false,'logout invalidates the old busy token');

 h=sun();pending=h.run('sunExecute()');h.nodes['sun-panel'].hidden=true;h.request.resolve({content:'Restored synthetic identifier',status:'draft'});await pending;
 assert.deepEqual(h.spoken,[]);assert.equal(h.nodes['sun-answer'].textContent,'');assert.equal(h.context.sunBusy,false);

 h=sun();pending=h.run('sunExecute()');h.context.signature='edited';h.context.sunPreviewRevision++;const latest={id:'latest review'};h.context.sunPrivacyReview=latest;h.request.resolve({content:'Old answer',status:'draft'});await pending;
 assert.deepEqual(h.spoken,[]);assert.equal(h.context.sunPrivacyReview,latest);assert.equal(h.nodes['sun-answer'].textContent,'');

 h=sun();pending=h.run('sunExecute()');h.request.resolve({content:'Current synthetic answer',status:'draft'});await pending;
 assert.equal(h.nodes['sun-answer'].textContent,'Current synthetic answer');assert.deepEqual(h.spoken,['Current synthetic answer']);
 console.log('PASS privacy async view/session/edit guards, request ownership and preserved workflow review note');
})().catch(error=>{console.error(error);process.exitCode=1;});
