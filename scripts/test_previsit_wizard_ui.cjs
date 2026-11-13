// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The patient's step-by-step intake form, driven through a small stand-in page.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/previsit-public.js','utf8'),html=fs.readFileSync('web/previsit-intake.html','utf8'),css=fs.readFileSync('web/previsit.css','utf8');

class El{
 constructor(tag,page){this.tagName=tag.toUpperCase();this.page=page;this.children=[];this.attributes={};this.listeners={};this.hidden=false;this.disabled=false;this.checked=false;this.value='';this.own='';}
 append(...items){for(const item of items)this.children.push(typeof item==='string'?Object.assign(new El('#text',this.page),{own:item}):item);}
 replaceChildren(...items){this.children=[];this.own='';this.append(...items);}
 set textContent(value){this.children=[];this.own=String(value??'');}
 get textContent(){return this.own+this.children.map(child=>child.textContent).join('');}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 removeAttribute(name){delete this.attributes[name];}
 addEventListener(type,listener){(this.listeners[type]??=[]).push(listener);}
 fire(type){for(const listener of this.listeners[type]||[])listener({type,target:this,preventDefault(){}});}
 focus(){this.page.focused=this;}
 scrollIntoView(){}
 walk(found=[]){for(const child of this.children){found.push(child);child.walk(found);}return found;}
}
const SHELL=['practice-name','intake-progress','intake-step-count','intake-bar','intake-step-list','intake-title','intake-context','intake-errors','intake-form','intake-body','intake-actions','intake-saved','result'];
for(const id of SHELL)assert.ok(html.includes(`id="${id}"`),`page has #${id}`);

const states=['AL','AK','AZ','CA','NY','TX'],stateNames=['Alabama','Alaska','Arizona','California','New York','Texas'];
const insurance=(prefix,label,extra={})=>({label,show_if:{key:'payment_method',equals:'Insurance'},...extra,fields:[
 {key:prefix+'_company',label:'Insurance company',type:'text',required:true,max_length:200},
 {key:prefix+'_member_id',label:'Member or policy ID',type:'text',required:true},
 {key:prefix+'_relationship',label:'Who holds this policy?',type:'select',required:true,options:['Self','Spouse','Child','Other'],option_labels:['I do','My spouse','My parent','Someone else']},
 {key:prefix+'_holder_name',label:"Policy holder's full name",type:'text',required:true,show_if:{key:prefix+'_relationship',any_of:['Spouse','Child','Other']}}]});
const standard={base:'standard',attestation:'I confirm this synthetic information is correct.',sections:[
 {label:'About you',fields:[{key:'first_name',label:'First name',type:'text',required:true,max_length:100,autocomplete:'given-name'},{key:'last_name',label:'Last name',type:'text',required:true,autocomplete:'family-name'},{key:'date_of_birth',label:'Date of birth',type:'date',required:true,format:'past_date',autocomplete:'bday'},{key:'sex',label:'Sex',type:'select',required:false,options:['Female','Male','Unknown']},{key:'preferred_name',label:'Preferred name',type:'text',required:false,help:'What would you like us to call you?'}]},
 {label:'Contact',fields:[{key:'phone',label:'Mobile or main phone',type:'phone',required:true,format:'phone',inputmode:'tel',autocomplete:'tel'},{key:'phone_type',label:'What kind of phone is this?',type:'select',required:false,options:['Mobile','Home','Work']},{key:'email',label:'Email',type:'email',required:false,format:'email',inputmode:'email',autocomplete:'email'},{key:'address_line1',label:'Street address',type:'text',required:true,autocomplete:'address-line1'},{key:'city',label:'City',type:'text',required:true,autocomplete:'address-level2'},{key:'state',label:'State',type:'select',required:true,options:states,option_labels:stateNames,autocomplete:'address-level1'},{key:'zip',label:'ZIP code',type:'text',required:true,format:'zip',inputmode:'numeric',autocomplete:'postal-code'}]},
 {label:'More about you',intro:'These questions are optional.',fields:[{key:'marital_status',label:'Marital status',type:'select',required:false,options:['Single','Married','Partnered','Divorced','Separated','Widowed','Prefer not to say']},{key:'ethnicity',label:'Are you Hispanic or Latino?',type:'select',required:false,options:['Yes','No','Prefer not to say']}]},
 {label:'Emergency contact',fields:[{key:'emergency_name',label:'Their name',type:'text',required:true},{key:'emergency_phone',label:'Their phone',type:'phone',required:true,format:'phone',inputmode:'tel'}]},
 {label:'Who is responsible for the bill',fields:[{key:'responsible_party',label:'Who will pay for your care?',type:'select',required:true,options:['Myself','Someone else']},{key:'responsible_name',label:'Their name',type:'text',required:true,show_if:{key:'responsible_party',equals:'Someone else'}}]},
 {label:'How you will pay',fields:[{key:'payment_method',label:'How do you plan to pay for visits?',type:'select',required:true,options:['Insurance','Self-pay'],option_labels:['With insurance','I will pay myself']}]},
 insurance('insurance','Primary insurance'),
 insurance('insurance2','Secondary insurance',{skippable:true,skip_label:"I don't have a second insurance"}),
 {label:'Pharmacy and one last question',fields:[{key:'pharmacy_name',label:'Preferred pharmacy',type:'text',required:false},{key:'heard_about_us',label:'How did you hear about us?',type:'text',required:false}]}
]};
const older={attestation:'I confirm these synthetic answers.',sections:[{label:'Patient details',fields:[{key:'insurance_plan',label:'Insurance plan',type:'text',required:true},{key:'history',label:'Health history',type:'textarea',required:false}]},{label:'Consent',fields:[{key:'consent',label:'I consent to treatment',type:'checkbox',required:true}]}]};

function open(packet,options={}){
 const page={focused:null,nodes:{},calls:[],storage:new Map(),title:''};
 for(const id of SHELL)page.nodes[id]=Object.assign(new El('div',page),{id});
 page.nodes['intake-form'].hidden=true;page.nodes['intake-progress'].hidden=true;
 const location={hash:'hash' in options?options.hash:'#token=synthetic-link-secret',pathname:'/intake'};
 let ready;
 const context={console,URLSearchParams,Intl,Date,Promise,JSON,Object,Array,Number,String,Set,Map,Math,location,setTimeout,clearTimeout,
  history:{replaceState(_state,_title,path){location.hash='';location.pathname=path;}},
  sessionStorage:{getItem:key=>page.storage.get(key)??null,setItem:(key,value)=>page.storage.set(key,value),removeItem:key=>page.storage.delete(key)},
  document:{body:{dataset:{previsitPage:'intake'}},get title(){return page.title;},set title(value){page.title=value;},getElementById:id=>page.nodes[id]||null,createElement:tag=>new El(tag,page),addEventListener:(_type,listener)=>{ready=listener;}},
  fetch:async(url,request)=>{
   const body=JSON.parse(request.body),action=url.split('/').pop();page.calls.push([action,body]);
   const reply=options[action]?options[action](body):action==='read'?packet:action==='save'?{status:'in_progress'}:action==='lookup'?{items:[]}:{status:'submitted',message:'Received'};
   return reply.failure?{ok:false,status:reply.failure,json:async()=>({message:reply.message})}:{ok:true,status:200,json:async()=>reply};
  }};
 vm.createContext(context);vm.runInContext(source,context);ready();
 const $=id=>page.nodes[id],settle=()=>new Promise(resolve=>setImmediate(resolve));
 const nodes=()=>$('intake-body').walk(),named=name=>nodes().filter(node=>node.name===name&&!['FIELDSET'].includes(node.tagName));
 const wrapOf=name=>$('intake-body').children.find(wrap=>wrap.walk().some(node=>node.name===name));
 const api={page,context,$,settle,nodes,named,wrapOf,
  type(name,value){const [input]=named(name);assert.ok(input,`question ${name} is on this step`);input.value=value;input.fire('input');},
  choose(name,value){const inputs=named(name);if(inputs[0].tagName==='SELECT'){inputs[0].value=value;inputs[0].fire('change');return;}const pick=inputs.find(input=>input.value===value);assert.ok(pick,`${name} offers ${value}`);for(const input of inputs)input.checked=input===pick;pick.fire('change');},
  tick(name,value=true){const [input]=named(name);input.checked=value;input.fire('change');},
  button(text){return $('intake-actions').children.concat(nodes(),$('result').walk()).find(node=>node.tagName==='BUTTON'&&node.textContent===text);},
  async press(text){const button=api.button(text);assert.ok(button,`button “${text}” is shown`);if(button.type==='submit')$('intake-form').fire('submit');else button.fire('click');await settle();},
  errorFor(name){const wrap=wrapOf(name),error=wrap.walk().find(node=>node.className==='field-error');return error.hidden?'':error.textContent;},
  saves:()=>page.calls.filter(call=>call[0]==='save'),
  step:()=>`${$('intake-step-count').textContent} · ${$('intake-title').textContent}`};
 return api;
}
const packet=(extra={})=>({packet_id:'packet-1',status:'sent',template:standard,draft:null,practice_name:'Synthetic Family Clinic',patient:{given_name:'Avery'},appointment:null,...extra});
const about=p=>{p.type('first_name','Avery');p.type('last_name','Sample');p.type('date_of_birth','1990-04-12');};
const contact=p=>{p.type('phone','555-010-2026');p.type('address_line1','100 Example Street');p.type('city','Sampleville');p.choose('state','TX');p.type('zip','75001');};

(async()=>{
 // Opening the link: practice name, first step, and the link secret leaves the address bar.
 let p=open(packet());await p.settle();
 assert.deepEqual(p.page.calls[0],['read',{token:'synthetic-link-secret'}]);
 assert.equal(p.context.location.hash,'','the link secret is removed from the address bar');
 assert.equal(p.$('practice-name').textContent,'Synthetic Family Clinic');
 assert.doesNotMatch(p.page.title+p.$('practice-name').textContent,/SunCharts/);
 assert.equal(p.step(),'Step 1 of 7 · About you','insurance steps are not counted until the patient chooses insurance');
 assert.match(p.$('intake-context').textContent,/^Avery, please fill this in before your visit\./);
 assert.equal(p.$('intake-form').hidden,false);assert.equal(p.$('intake-progress').hidden,false);
 assert.equal(p.$('intake-bar').max,7);assert.equal(p.$('intake-bar').value,1);
 assert.deepEqual(p.$('intake-step-list').children.filter(item=>item.getAttribute('aria-current')==='step').map(item=>item.textContent),['About you']);
 assert.equal(p.page.focused,p.$('intake-title'),'each new step is announced from its heading');
 // Labels, hints and browser autofill.
 const first=p.named('first_name')[0];
 assert.equal(first.getAttribute('autocomplete'),'given-name');assert.equal(first.getAttribute('aria-required'),'true');assert.equal(first.getAttribute('maxlength'),'100');
 assert.equal(p.named('last_name')[0].getAttribute('autocomplete'),'family-name');assert.equal(p.named('date_of_birth')[0].getAttribute('autocomplete'),'bday');assert.equal(p.named('date_of_birth')[0].type,'date');
 const label=p.wrapOf('first_name').children.find(node=>node.tagName==='LABEL');assert.equal(label.htmlFor,first.id);assert.equal(label.textContent,'First name');
 assert.match(p.wrapOf('preferred_name').textContent,/Preferred name \(optional\)/);
 const hint=p.wrapOf('preferred_name').walk().find(node=>node.className==='help');assert.ok(p.named('preferred_name')[0].getAttribute('aria-describedby').includes(hint.id));
 // Up to five choices are large buttons inside a named group; nothing is pre-selected.
 const sex=p.wrapOf('sex');assert.equal(sex.tagName,'FIELDSET');assert.equal(sex.children[0].tagName,'LEGEND');assert.equal(p.named('sex').length,3);assert.ok(p.named('sex').every(radio=>radio.type==='radio'&&!radio.checked));
 assert.ok(p.button('Continue'));assert.equal(p.button('Back'),undefined,'no Back on the first step');

 // Continue with nothing filled in: plain messages beside each question, focus on the first.
 await p.press('Continue');
 assert.equal(p.step(),'Step 1 of 7 · About you');
 assert.equal(p.errorFor('first_name'),'Please answer this question.');assert.equal(p.errorFor('date_of_birth'),'Please answer this question.');assert.equal(p.errorFor('preferred_name'),'');
 assert.equal(first.getAttribute('aria-invalid'),'true');assert.ok(first.getAttribute('aria-describedby').includes(p.wrapOf('first_name').walk().find(node=>node.className==='field-error').id));
 assert.equal(p.$('intake-errors').textContent,'Please fix the 3 answers marked below.');assert.equal(p.page.focused,first);
 assert.equal(p.saves().length,0,'nothing is saved while a step has problems');
 about(p);p.type('date_of_birth','2999-01-01');await p.press('Continue');
 assert.equal(p.errorFor('date_of_birth'),'This date cannot be in the future.');assert.equal(first.getAttribute('aria-invalid'),null);
 p.type('date_of_birth','1990-04-12');p.choose('sex','Female');assert.equal(p.button('Clear answer')?.type,'button');

 // Answers are saved when the patient continues.
 await p.press('Continue');
 assert.equal(p.step(),'Step 2 of 7 · Contact');
 assert.equal(p.saves().length,1);assert.equal(p.saves()[0][1].token,'synthetic-link-secret');
 assert.deepEqual(p.saves()[0][1].answers,{first_name:'Avery',last_name:'Sample',date_of_birth:'1990-04-12',sex:'Female',preferred_name:'',phone:'',phone_type:'',email:'',address_line1:'',city:'',state:'',zip:'',marital_status:'',ethnicity:'',emergency_name:'',emergency_phone:'',responsible_party:'',payment_method:'',pharmacy_name:'',heard_about_us:''});
 assert.equal(p.$('intake-saved').textContent,'Saved');
 const phone=p.named('phone')[0];assert.equal(phone.type,'tel');assert.equal(phone.getAttribute('inputmode'),'tel');assert.equal(phone.getAttribute('autocomplete'),'tel');
 assert.equal(p.named('email')[0].getAttribute('autocomplete'),'email');assert.equal(p.named('address_line1')[0].getAttribute('autocomplete'),'address-line1');assert.equal(p.named('city')[0].getAttribute('autocomplete'),'address-level2');
 const zip=p.named('zip')[0];assert.equal(zip.getAttribute('inputmode'),'numeric');assert.equal(zip.getAttribute('autocomplete'),'postal-code');
 // A long list is a drop-down that shows full names and keeps the short value.
 const state=p.named('state')[0];assert.equal(state.tagName,'SELECT');assert.equal(state.getAttribute('autocomplete'),'address-level1');assert.deepEqual(state.children.slice(0,2).map(option=>[option.value,option.textContent]),[['','Choose…'],['AL','Alabama']]);
 assert.equal(p.named('phone_type')[0].type,'radio');
 contact(p);
 p.type('phone','12');p.type('zip','7500');p.type('email','not-an-email');p.$('intake-saved').textContent='stale';p.type('city','Sampleville');assert.equal(p.$('intake-saved').textContent,'','the Saved note clears once the patient types again');
 await p.press('Continue');
 assert.equal(p.errorFor('phone'),'Please enter a phone number with its area code, like 555-123-4567.');assert.equal(p.errorFor('zip'),'Please enter a 5-digit ZIP code.');assert.equal(p.errorFor('email'),'Please enter an email address like name@example.com.');
 p.type('phone','(555) 010-2026');p.type('zip','75001');p.type('email','');await p.press('Continue');
 assert.equal(p.step(),'Step 3 of 7 · More about you');assert.equal(p.$('intake-context').textContent,'These questions are optional.');
 // Seven choices use a drop-down; an all-optional step can be passed without answering.
 assert.equal(p.named('marital_status')[0].tagName,'SELECT');assert.equal(p.named('ethnicity').length,3);
 await p.press('Back');assert.equal(p.step(),'Step 2 of 7 · Contact');assert.equal(p.named('city')[0].value,'Sampleville','going back keeps what was typed');assert.equal(p.named('state')[0].value,'TX');
 await p.press('Continue');await p.press('Continue');
 assert.equal(p.step(),'Step 4 of 7 · Emergency contact');p.type('emergency_name','Jordan Example');p.type('emergency_phone','555-010-3030');await p.press('Continue');

 // A follow-up question appears only when its answer calls for it.
 assert.equal(p.step(),'Step 5 of 7 · Who is responsible for the bill');
 assert.equal(p.wrapOf('responsible_name').hidden,true);
 p.choose('responsible_party','Someone else');assert.equal(p.wrapOf('responsible_name').hidden,false);
 await p.press('Continue');assert.equal(p.errorFor('responsible_name'),'Please answer this question.');
 p.choose('responsible_party','Myself');assert.equal(p.wrapOf('responsible_name').hidden,true);
 await p.press('Continue');assert.equal(p.step(),'Step 6 of 7 · How you will pay');
 assert.deepEqual(p.wrapOf('payment_method').walk().filter(node=>node.className==='choice').map(node=>node.textContent),['With insurance','I will pay myself']);
 await p.press('Continue');assert.equal(p.errorFor('payment_method'),'Please choose an answer.');assert.equal(p.wrapOf('payment_method').getAttribute('aria-invalid'),'true');
 // Choosing insurance adds the insurance steps and the count follows.
 p.choose('payment_method','Insurance');await p.press('Continue');
 assert.equal(p.step(),'Step 7 of 9 · Primary insurance');
 p.type('insurance_company','Example Health Plan');p.type('insurance_member_id','SYN-12345');
 assert.equal(p.wrapOf('insurance_holder_name').hidden,true);p.choose('insurance_relationship','Spouse');assert.equal(p.wrapOf('insurance_holder_name').hidden,false);
 await p.press('Continue');assert.equal(p.errorFor('insurance_holder_name'),'Please answer this question.');
 p.choose('insurance_relationship','Self');await p.press('Continue');
 // A step that can be skipped says so in the practice's words.
 assert.equal(p.step(),'Step 8 of 9 · Secondary insurance');
 p.type('insurance2_company','Typed by mistake');const before=p.saves().length;
 await p.press("I don't have a second insurance");
 assert.equal(p.step(),'Step 9 of 9 · Pharmacy and one last question');assert.equal(p.saves().length,before+1);
 assert.equal(p.saves().at(-1)[1].answers.insurance2_company,'','skipping clears that step');
 await p.press('Back');assert.equal(p.step(),'Step 8 of 9 · Secondary insurance');
 // Starting a skippable step means finishing it; leaving it blank is fine.
 p.type('insurance2_member_id','ONLY-ID');await p.press('Continue');assert.equal(p.errorFor('insurance2_company'),'Please answer this question.');
 p.type('insurance2_member_id','');await p.press('Continue');assert.equal(p.step(),'Step 9 of 9 · Pharmacy and one last question');
 p.type('pharmacy_name','Example Pharmacy');await p.press('Continue');

 // Review: every answer grouped by step, each with its own Edit.
 assert.equal(p.$('intake-title').textContent,'Check your answers');assert.equal(p.$('intake-step-count').textContent,'Last step: check and send');
 assert.deepEqual(p.$('intake-step-list').children.filter(item=>item.getAttribute('aria-current')==='step').map(item=>item.textContent),['Check your answers']);
 const groups=()=>p.$('intake-body').children.filter(node=>node.className==='review-group');
 assert.deepEqual(groups().map(group=>group.walk().find(node=>node.tagName==='H2').textContent),['About you','Contact','More about you','Emergency contact','Who is responsible for the bill','How you will pay','Primary insurance','Secondary insurance','Pharmacy and one last question']);
 assert.ok(groups().every(group=>group.walk().some(node=>node.tagName==='BUTTON'&&node.textContent==='Edit'&&node.getAttribute('aria-label').startsWith('Edit '))));
 const reviewText=p.$('intake-body').textContent;
 assert.match(reviewText,/StateTexas/);assert.match(reviewText,/Date of birthApril 12, 1990/);assert.match(reviewText,/How do you plan to pay for visits\?With insurance/);assert.match(reviewText,/EmailNot answered/);assert.match(reviewText,/Who holds this policy\?I do/);
 assert.doesNotMatch(reviewText,/Their name.*Policy holder's full name/s,'questions that were not shown are not listed');assert.doesNotMatch(reviewText,/Policy holder/);
 assert.match(reviewText,/I confirm this synthetic information is correct\./);
 // Edit one step and come straight back.
 groups()[1].walk().find(node=>node.textContent==='Edit').fire('click');
 assert.equal(p.$('intake-title').textContent,'Contact');assert.ok(p.button('Back to your answers'));
 p.type('city','New Sampleton');await p.press('Continue');
 assert.equal(p.$('intake-title').textContent,'Check your answers');assert.match(p.$('intake-body').textContent,/CityNew Sampleton/);
 // Sending needs the confirmation and a typed name.
 await p.press('Send to the practice');
 assert.equal(p.page.calls.filter(call=>call[0]==='submit').length,0);assert.equal(p.$('intake-errors').textContent,'Please confirm your answers and type your name.');
 assert.equal(p.named('attested')[0].getAttribute('aria-invalid'),'true');assert.equal(p.named('attested_name')[0].getAttribute('autocomplete'),'name');
 p.tick('attested');p.type('attested_name','  Avery Sample ');await p.press('Send to the practice');
 const sent=p.page.calls.find(call=>call[0]==='submit')[1];
 assert.equal(sent.token,'synthetic-link-secret');assert.equal(sent.attested,true);assert.equal(sent.attested_name,'Avery Sample');
 assert.equal(sent.response.city,'New Sampleton');assert.equal(sent.response.insurance_company,'Example Health Plan');assert.equal(sent.response.insurance2_company,'');
 assert.ok(!('responsible_name' in sent.response)&&!('insurance_holder_name' in sent.response),'answers to hidden questions are not sent');
 assert.equal(p.$('intake-title').textContent,'Thank you, Avery');assert.equal(p.$('intake-context').textContent,'Your answers were sent to Synthetic Family Clinic.');
 assert.match(p.$('result').textContent,/What happens next.*look over your answers before your visit.*You can close this page\./s);assert.equal(p.$('intake-form').hidden,true);assert.equal(p.$('intake-progress').hidden,true);
 assert.equal(p.page.storage.has('intake-token'),false);

 // Self-pay: no insurance steps, and earlier insurance answers are not sent.
 const done={first_name:'Avery',last_name:'Sample',date_of_birth:'1990-04-12',phone:'555-010-2026',address_line1:'100 Example Street',city:'Sampleville',state:'TX',zip:'75001',marital_status:'Single',emergency_name:'Jordan Example',emergency_phone:'555-010-3030',responsible_party:'Myself',payment_method:'Self-pay',insurance_company:'Left over',pharmacy_name:'Example Pharmacy'};
 p=open(packet({status:'in_progress',draft:done}));await p.settle();
 // Coming back with everything answered goes to the review, with a welcome-back note.
 assert.equal(p.$('intake-title').textContent,'Check your answers');assert.equal(p.$('intake-saved').textContent,'Welcome back. Your earlier answers were saved.');
 assert.equal(p.$('intake-body').children.filter(node=>node.className==='review-group').length,7);
 // Changing to insurance from the review opens the step that now needs answers.
 p.$('intake-body').children.filter(node=>node.className==='review-group')[5].walk().find(node=>node.textContent==='Edit').fire('click');
 p.choose('payment_method','Insurance');await p.press('Continue');
 assert.equal(p.$('intake-title').textContent,'Primary insurance');assert.equal(p.named('insurance_company')[0].value,'Left over');
 await p.press('Back to your answers');p.tick('attested');p.type('attested_name','Avery Sample');await p.press('Send to the practice');
 assert.equal(p.$('intake-title').textContent,'Primary insurance','sending is held until the newly opened step is complete');assert.equal(p.errorFor('insurance_member_id'),'Please answer this question.');
 assert.equal(p.page.calls.filter(call=>call[0]==='submit').length,0);

 // Coming back part way: resume at the first step that still needs answers.
 p=open(packet({status:'in_progress',draft:{first_name:'Avery',last_name:'Sample',date_of_birth:'1990-04-12',phone:'555-010-2026',address_line1:'100 Example Street',city:'Sampleville',state:'TX',zip:'75001',marital_status:'',ethnicity:''}}),{hash:''});
 p.page.storage.set('intake-token','kept-for-this-tab');p.context.document.body.dataset.previsitPage='intake';
 await p.settle();
 assert.match(p.$('result').textContent,/This link is incomplete/,'a link without its secret explains what to do');
 p=open(packet({status:'in_progress',draft:{first_name:'Avery',last_name:'Sample',date_of_birth:'1990-04-12',phone:'555-010-2026',address_line1:'100 Example Street',city:'Sampleville',state:'TX',zip:'75001',marital_status:'',ethnicity:''}}));await p.settle();
 assert.equal(p.step(),'Step 3 of 7 · More about you');assert.equal(p.$('intake-saved').textContent,'Welcome back. Your earlier answers were saved.');
 await p.press('Back');assert.equal(p.named('first_name').length,0);assert.equal(p.named('city')[0].value,'Sampleville');assert.equal(p.named('state')[0].value,'TX');

 // A form issued before the step-by-step design works the same way.
 p=open(packet({template:older,appointment:{starts_at:'2026-12-01T15:00:00Z',title:'Synthetic visit'}}));await p.settle();
 assert.equal(p.step(),'Step 1 of 2 · Patient details');assert.match(p.$('intake-context').textContent,/before your visit on \w+, December 1\./);
 assert.equal(p.named('history')[0].tagName,'TEXTAREA');
 await p.press('Continue');assert.equal(p.errorFor('insurance_plan'),'Please answer this question.');
 p.type('insurance_plan','Synthetic Plan');await p.press('Continue');assert.equal(p.step(),'Step 2 of 2 · Consent');
 assert.equal(p.named('consent')[0].type,'checkbox');await p.press('Continue');assert.equal(p.errorFor('consent'),'Please tick this box to continue.');
 p.tick('consent');await p.press('Continue');p.tick('attested');p.type('attested_name','Avery Sample');await p.press('Send to the practice');
 assert.deepEqual(p.page.calls.find(call=>call[0]==='submit')[1].response,{insurance_plan:'Synthetic Plan',history:'',consent:true});
 assert.equal(p.$('intake-title').textContent,'Thank you, Avery');

 // A link that no longer works shows the practice's one plain message and no form.
 const closed='This link has expired or is no longer active. Please ask the practice for a new one.';
 p=open(packet(),{read:()=>({failure:404,message:closed})});await p.settle();
 assert.equal(p.$('result').textContent,closed);assert.equal(p.$('result').className,'error');assert.equal(p.$('intake-title').textContent,'We could not open your forms');assert.equal(p.$('intake-form').hidden,true);
 // If the link is cancelled while the patient is filling it in, they are told and stay put.
 p=open(packet(),{save:()=>({failure:404,message:closed})});await p.settle();about(p);await p.press('Continue');
 assert.equal(p.step(),'Step 1 of 7 · About you');assert.equal(p.$('intake-errors').textContent,closed);
 // A brief connection problem does not lose the patient's place.
 p=open(packet(),{save:()=>({failure:503,message:'Unavailable'})});await p.settle();about(p);await p.press('Continue');
 assert.equal(p.step(),'Step 2 of 7 · Contact');assert.match(p.$('intake-saved').textContent,/could not save your progress just now/);
 // Already sent: say so, and allow a correction.
 p=open(packet({status:'submitted'}));await p.settle();
 assert.equal(p.$('intake-title').textContent,'You have already sent this form');assert.equal(p.$('intake-form').hidden,true);
 await p.press('Fill it in again');assert.equal(p.step(),'Step 1 of 7 · About you');about(p);await p.press('Continue');assert.equal(p.saves().length,0,'a form already sent is not turned back into a draft');
 // A failed send keeps the answers and shows the reason.
 p=open(packet({template:older}),{submit:()=>({failure:400,message:'Please answer every required question.'})});await p.settle();
 p.type('insurance_plan','Synthetic Plan');await p.press('Continue');p.tick('consent');await p.press('Continue');p.tick('attested');p.type('attested_name','Avery Sample');await p.press('Send to the practice');
 assert.equal(p.$('intake-errors').textContent,'Please answer every required question.');assert.equal(p.$('intake-title').textContent,'Check your answers');

 // Pick-from-list questions: the patient chooses a match instead of typing free text.
 const picker={attestation:'I confirm.',sections:[{label:'Primary insurance',fields:[{key:'insurance_company',label:'Insurance company',type:'text',required:true,lookup:'insurer',id_key:'insurance_company_id',help:'Start typing and choose yours from the list.'},{key:'insurance_company_id',label:'Chosen from the list',type:'text',hidden:true},{key:'race',label:'Race',type:'select',required:false,options:['Asian','White','Other'],other_key:'race_other'},{key:'race_other',label:'Please tell us',type:'text',required:true,show_if:{key:'race',equals:'Other'}}]},{label:'Pharmacy',fields:[{key:'pharmacy_name',label:'Preferred pharmacy',type:'text',required:false,lookup:'pharmacy',id_key:'pharmacy_name_id'},{key:'pharmacy_name_id',label:'Chosen from the list',type:'text',hidden:true}]}]};
 const directory=body=>({items:body.kind==='insurer'?[{id:'payer-1',name:'Example Health Plan'},{id:'claimmd:EX123',name:'Example Mutual'}].filter(item=>item.name.toLowerCase().includes(body.query.toLowerCase())):[{id:'pharmacy-1',name:'Example Pharmacy, 1 Example Street'}]});
 const pause=()=>new Promise(resolve=>setTimeout(resolve,260));
 p=open(packet({template:picker}),{lookup:directory});await p.settle();
 assert.equal(p.step(),'Step 1 of 2 · Primary insurance');assert.equal(p.named('insurance_company_id').length,0,'the reference is never shown as a question');
 let box=p.named('insurance_company')[0];assert.equal(box.getAttribute('role'),'combobox');assert.equal(box.getAttribute('aria-autocomplete'),'list');assert.equal(box.getAttribute('autocomplete'),'off');
 const within=name=>p.wrapOf(name).walk(),options=name=>within(name).filter(node=>node.getAttribute('role')==='option').map(node=>node.textContent),status=name=>within(name).find(node=>node.className==='lookup-status').textContent;
 p.type('insurance_company','E');await pause();assert.equal(p.page.calls.filter(call=>call[0]==='lookup').length,0,'one letter does not search');assert.equal(status('insurance_company'),'Keep typing to see matches.');
 p.type('insurance_company','exam');await pause();
 assert.deepEqual(p.page.calls.filter(call=>call[0]==='lookup').at(-1)[1],{token:'synthetic-link-secret',kind:'insurer',query:'exam'});
 assert.deepEqual(options('insurance_company'),['Example Health Plan','Example Mutual']);assert.equal(box.getAttribute('aria-expanded'),'true');assert.match(status('insurance_company'),/2 matches\. Choose one below\./);
 // Typed letters alone are not an answer.
 await p.press('Continue');assert.equal(p.errorFor('insurance_company'),'Please choose a match from the list, or choose “I can’t find mine”.');assert.equal(p.saves().length,0);
 within('insurance_company').find(node=>node.getAttribute('role')==='option'&&node.textContent==='Example Mutual').fire('click');
 assert.equal(box.value,'Example Mutual');assert.equal(status('insurance_company'),'Chosen: Example Mutual');assert.equal(box.getAttribute('aria-expanded'),'false');
 // "Other" opens a text box only when chosen.
 assert.equal(p.wrapOf('race_other').hidden,true);p.choose('race','Other');assert.equal(p.wrapOf('race_other').hidden,false);p.type('race_other','Synthetic answer');
 await p.press('Continue');assert.equal(p.step(),'Step 2 of 2 · Pharmacy');
 assert.deepEqual({...p.saves().at(-1)[1].answers},{insurance_company:'Example Mutual',insurance_company_id:'claimmd:EX123',race:'Other',race_other:'Synthetic answer',pharmacy_name:'',pharmacy_name_id:''});
 // Changing the text after choosing drops the choice.
 await p.press('Back');box=p.named('insurance_company')[0];assert.equal(box.value,'Example Mutual');p.type('insurance_company','Example Mut');await p.press('Continue');assert.equal(p.errorFor('insurance_company'),'Please choose a match from the list, or choose “I can’t find mine”.');
 // "I can't find mine" is a secondary link that turns the question into a plain text box.
 const toggle=within('insurance_company').find(node=>node.className==='link lookup-toggle');assert.equal(toggle.textContent,'I can’t find mine');toggle.fire('click');
 assert.equal(box.getAttribute('role'),null);assert.equal(toggle.textContent,'Search the list instead');p.type('insurance_company','Tiny Local Plan');await p.press('Continue');
 assert.equal(p.saves().at(-1)[1].answers.insurance_company,'Tiny Local Plan');assert.equal(p.saves().at(-1)[1].answers.insurance_company_id,'','a typed name carries no reference');
 // An optional pick-from-list question can be left blank; the review never lists the reference.
 p.type('pharmacy_name','exa');await pause();assert.deepEqual(options('pharmacy_name'),['Example Pharmacy, 1 Example Street']);
 within('pharmacy_name').find(node=>node.getAttribute('role')==='option').fire('click');await p.press('Continue');
 assert.equal(p.$('intake-title').textContent,'Check your answers');assert.match(p.$('intake-body').textContent,/Insurance companyTiny Local Plan/);assert.match(p.$('intake-body').textContent,/Preferred pharmacyExample Pharmacy, 1 Example Street/);assert.doesNotMatch(p.$('intake-body').textContent,/Chosen from the list|pharmacy-1/);
 p.tick('attested');p.type('attested_name','Avery Sample');await p.press('Send to the practice');
 assert.deepEqual({...p.page.calls.find(call=>call[0]==='submit')[1].response},{insurance_company:'Tiny Local Plan',insurance_company_id:'',race:'Other',race_other:'Synthetic answer',pharmacy_name:'Example Pharmacy, 1 Example Street',pharmacy_name_id:'pharmacy-1'});
 // Coming back: a chosen record is still chosen, and a typed name comes back as typed.
 p=open(packet({template:picker,status:'in_progress',draft:{insurance_company:'Example Health Plan',insurance_company_id:'payer-1'}}),{lookup:directory});await p.settle();
 await p.press('Continue');assert.equal(p.saves().at(-1)[1].answers.insurance_company_id,'payer-1');
 p=open(packet({template:picker,status:'in_progress',draft:{insurance_company:'Tiny Local Plan',insurance_company_id:''}}),{lookup:directory});await p.settle();await p.press('Back');
 assert.equal(p.named('insurance_company')[0].value,'Tiny Local Plan');assert.equal(p.wrapOf('insurance_company').walk().find(node=>node.className==='link lookup-toggle').textContent,'Search the list instead');
 // If the list cannot be reached the patient is told how to carry on.
 p=open(packet({template:picker}),{lookup:()=>({failure:429,message:'Too many tries'})});await p.settle();p.type('insurance_company','exam');await pause();await p.settle();
 assert.match(p.wrapOf('insurance_company').walk().find(node=>node.className==='lookup-status').textContent,/not available right now\. Choose “I can’t find mine”/);

 // The page itself: no inline script or style, live regions, and room for thumbs.
 assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i);assert.doesNotMatch(source,/innerHTML|insertAdjacentHTML|document\.write|\.style\./);
 assert.match(html,/id="intake-errors"[^>]*role="alert"[^>]*aria-live="assertive"/);assert.match(html,/id="intake-saved"[^>]*aria-live="polite"/);assert.match(html,/<progress id="intake-bar"/);assert.match(html,/name="viewport" content="width=device-width,initial-scale=1"/);
 assert.doesNotMatch(html,/SunCharts EHR<\/strong>/);
 assert.match(css,/\.field \.choice\{[^}]*min-height:48px/);assert.match(css,/\.wizard-actions button\{[^}]*min-height:48px/);assert.match(css,/\[hidden\]\{display:none!important\}/);assert.match(css,/@media\(max-width:480px\)\{[^}]*\}\.wizard-actions button\{flex:1 1 100%\}/);
 for(const word of ['packet','token','schema','payload','snapshot','idempotent'])assert.doesNotMatch(html.replace(/<script[^>]*>|<link[^>]*>/g,''),new RegExp(word,'i'),`the page does not say “${word}”`);
 const said=[...source.matchAll(/(?:text|textContent)\s*[:=]\s*(?:'([^']*)'|`([^`]*)`)/g)].map(match=>match[1]||match[2]).join('\n');
 for(const word of ['packet','token','schema','payload','snapshot','idempotent','template'])assert.doesNotMatch(said.replace(/\$\{[^}]*\}/g,''),new RegExp(`\\b${word}`,'i'),`patients are never shown “${word}”`);
 console.log('PASS patient intake steps: order and count, conditional and skippable steps, plain errors beside fields, save on continue, resume, review and edit, send, older forms, closed links');
})().catch(error=>{console.error(error);process.exitCode=1;});
