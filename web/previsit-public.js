// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const q=id=>document.getElementById(id);
async function request(url,options={}){const response=await fetch(url,{...options,cache:'no-store',headers:{'Content-Type':'application/json',...(options.headers||{})}});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.message||'The practice could not process this request.');error.status=response.status;throw error;}return data;}
async function booking(){const slug=decodeURIComponent(location.pathname.split('/').filter(Boolean).pop());const profile=await request(`/api/public/v1/booking/${encodeURIComponent(slug)}`);q('practice-name').textContent=profile.practice_name;q('booking-title').textContent=`Request a visit with ${profile.provider_name}`;q('welcome').textContent=profile.welcome_text||`Request a ${profile.duration_minutes}-minute appointment. The practice will review your information.`;const form=q('booking-form'),slots=q('available-slots');for(const value of profile.available_slots){const option=document.createElement('option');option.value=value;option.textContent=new Intl.DateTimeFormat(undefined,{dateStyle:'full',timeStyle:'short',timeZone:profile.booking_timezone}).format(new Date(value));slots.append(option);}if(!profile.available_slots.length){const option=document.createElement('option');option.textContent='No appointments are currently available';option.disabled=true;slots.append(option);form.querySelector('button').disabled=true;}form.hidden=false;form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;q('result').className='';q('result').textContent='Sending your request…';try{const data=Object.fromEntries(new FormData(form));data.request_id=crypto.randomUUID();const saved=await request(`/api/public/v1/booking/${encodeURIComponent(slug)}`,{method:'POST',body:JSON.stringify(data)});form.hidden=true;q('result').textContent='Your appointment request was received.';if(saved.intake_url){const link=document.createElement('a');link.href=saved.intake_url;link.textContent=' Complete your pre-visit forms now.';q('result').append(link);}}catch(error){q('result').className='error';q('result').textContent=error.message;button.disabled=false;}});}

// ---------------------------------------------------------------------------
// Intake form: one step per screen. The rules below mirror the server, which
// checks everything again when the form is sent.
// ---------------------------------------------------------------------------
const INTAKE_AUTOCOMPLETE=['name','given-name','additional-name','family-name','honorific-suffix','bday','tel','email','address-line1','address-line2','address-level2','address-level1','postal-code','off'];
const INTAKE_INPUT_MODES=['text','tel','email','numeric','decimal'];
const INTAKE_RADIO_LIMIT=5;
function intakeEmpty(value){return value===undefined||value===null||value===false||(typeof value==='string'&&value.trim()==='');}
// Whether a "show only when" rule is met. A rule that points at a question the
// patient is not being shown is never met.
function intakeRuleMet(rule,answers,shown){
 if(!rule||typeof rule!=='object'||typeof rule.key!=='string')return true;
 if(!shown.has(rule.key))return false;
 const answer=answers[rule.key];
 if('equals' in rule)return answer===rule.equals;
 return Array.isArray(rule.any_of)&&rule.any_of.includes(answer);
}
// The steps the patient should see for these answers, in order, each with the
// questions currently shown. Steps with nothing to show are left out.
function intakeLayout(template,answers){
 const shown=new Set(),steps=[];
 (template?.sections||[]).forEach((section,index)=>{
  const sectionShown=intakeRuleMet(section.show_if,answers,shown),fields=[];
  for(const field of section.fields||[]){if(sectionShown&&intakeRuleMet(field.show_if,answers,shown)){shown.add(field.key);fields.push(field);}}
  if(fields.some(field=>field.hidden!==true))steps.push({index,section,fields});
 });
 return {steps,shown};
}
function intakeFormatError(field,text){
 if(field.type==='number'&&!Number.isFinite(Number(text)))return 'Please enter a number.';
 if(field.type==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(text))return 'Please enter a full date.';
 if(field.type==='select'&&!(field.options||[]).includes(text))return 'Please choose one of the answers.';
 const limit=Math.min(field.type==='textarea'?10000:1000,Number(field.max_length)||Infinity);
 if([...text].length>limit)return `Please shorten this to ${limit} characters or fewer.`;
 if(field.format==='phone'&&!(text.length<=40&&(text.match(/\d/g)||[]).length>=7&&/^[\d+()\-. xX#]+$/.test(text)))return 'Please enter a phone number with its area code, like 555-123-4567.';
 if(field.format==='email'&&!/^[^\s@]+@[^\s@.][^\s@]*\.[^\s@]*[^\s@.]$/.test(text))return 'Please enter an email address like name@example.com.';
 if(field.format==='zip'&&!/^\d{5}(-\d{4})?$/.test(text))return 'Please enter a 5-digit ZIP code.';
 if(field.format==='past_date'){const day=new Date(text+'T00:00:00');if(Number.isNaN(day.getTime())||text<'1900-01-01')return 'Please enter a full date.';if(day.getTime()>Date.now())return 'This date cannot be in the future.';}
 return '';
}
function intakeFieldError(field,value){
 if(intakeEmpty(value)){
  if(field.required!==true)return '';
  if(field.type==='checkbox')return 'Please tick this box to continue.';
  if(field.type==='select')return 'Please choose an answer.';
  return 'Please answer this question.';
 }
 return field.type==='checkbox'?'':intakeFormatError(field,String(value).trim());
}
// Problems on one step, by question. A step the patient may skip asks for
// nothing while every answer on it is blank.
function intakeStepErrors(step,answers){
 const errors={},started=step.fields.some(field=>field.hidden!==true&&!intakeEmpty(answers[field.key]));
 if(step.section.skippable===true&&!started)return errors;
 for(const field of step.fields){if(field.hidden===true)continue;const message=intakeFieldError(field,answers[field.key]);if(message)errors[field.key]=message;}
 return errors;
}
// What is sent to the practice: only answers to questions that were shown.
function intakeResponse(template,answers){
 const response={};
 for(const step of intakeLayout(template,answers).steps)for(const field of step.fields){const value=answers[field.key];response[field.key]=field.type==='checkbox'?value===true:String(value??'').trim();}
 return response;
}
function intakeOptionLabel(field,option){const at=(field.options||[]).indexOf(option);return at>=0&&Array.isArray(field.option_labels)&&typeof field.option_labels[at]==='string'?field.option_labels[at]:option;}
function intakeAnswerText(field,value){
 if(field.type==='checkbox')return value===true?'Yes':'No';
 if(intakeEmpty(value))return 'Not answered';
 if(field.type==='select')return intakeOptionLabel(field,value);
 if(field.type==='date'){const day=new Date(value+'T00:00:00');return Number.isNaN(day.getTime())?String(value):day.toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});}
 return String(value);
}
// Where a returning patient picks up: the first step that still needs an
// answer or has not been touched. Returns the number of steps when all are done.
function intakeResumeAt(template,answers){
 const {steps}=intakeLayout(template,answers);
 const at=steps.findIndex(step=>Object.keys(intakeStepErrors(step,answers)).length||step.fields.every(field=>field.hidden===true||intakeEmpty(answers[field.key])));
 return at<0?steps.length:at;
}
function h(tag,props={},...children){
 const node=document.createElement(tag);
 for(const [key,value] of Object.entries(props)){
  if(value===undefined||value===null||value===false)continue;
  if(key==='text')node.textContent=value;
  else if(key==='on')for(const [type,listener] of Object.entries(value))node.addEventListener(type,listener);
  else if(['value','checked','hidden','disabled','className','id','type','name','htmlFor'].includes(key))node[key]=value;
  else node.setAttribute(key,value===true?'':String(value));
 }
 node.append(...children.filter(child=>child!==null&&child!==undefined&&child!==false));
 return node;
}
// A question answered by picking from a list (insurance company, pharmacy).
// The patient types a few letters and chooses a match; "I can't find mine"
// swaps the list for a plain text box. The chosen record's reference is kept
// beside the name so staff do not have to match it again.
function intakeLookupControl(field,value,pickedId,onChange,search){
 const id='q-'+field.key,helpId=id+'-help',errorId=id+'-error',listId=id+'-list',statusId=id+'-status';
 const optional=field.required===true?null:h('span',{className:'optional',text:' (optional)'});
 const error=h('p',{id:errorId,className:'field-error',hidden:true});
 const typed=typeof value==='string'?value:'';
 let picked=typed&&pickedId?{id:String(pickedId),name:typed}:null,manual=!!typed&&!picked,sequence=0,timer=null;
 const input=h('input',{id,name:field.key,type:'text',value:typed,maxlength:Math.min(1000,Number(field.max_length)||1000),autocomplete:'off','aria-describedby':`${helpId} ${statusId} ${errorId}`,'aria-required':field.required===true?'true':null});
 const list=h('ul',{id:listId,className:'lookup-list',role:'listbox','aria-label':field.label,hidden:true});
 const status=h('p',{id:statusId,className:'lookup-status',role:'status','aria-live':'polite'});
 const help=h('small',{id:helpId,className:'help'});
 const toggle=h('button',{type:'button',className:'link lookup-toggle'});
 const close=()=>{list.hidden=true;list.replaceChildren();input.setAttribute('aria-expanded','false');};
 const choose=item=>{picked={id:String(item.id),name:String(item.name)};input.value=picked.name;close();status.textContent=`Chosen: ${picked.name}`;onChange();input.focus?.();};
 const show=items=>{
  list.replaceChildren(...items.map(item=>h('li',{role:'presentation'},h('button',{type:'button',role:'option',className:'lookup-option',text:item.name,on:{click:()=>choose(item)}}))));
  list.hidden=!items.length;input.setAttribute('aria-expanded',items.length?'true':'false');
  status.textContent=items.length?`${items.length} match${items.length===1?'':'es'}. Choose one below.`:'No matches. Check the spelling, or choose “I can’t find mine”.';
 };
 const look=()=>{
  const query=input.value.trim(),mine=++sequence;
  if(query.length<2){close();status.textContent=query?'Keep typing to see matches.':'';return;}
  Promise.resolve().then(()=>search(field.lookup,query)).then(data=>{if(mine===sequence&&!manual)show(Array.isArray(data?.items)?data.items.filter(item=>item&&typeof item.name==='string').slice(0,10):[]);},()=>{if(mine===sequence&&!manual){close();status.textContent='The list is not available right now. Choose “I can’t find mine” to type it instead.';}});
 };
 const mode=()=>{
  help.textContent=manual?'Type the name as it appears on your card or label.':field.help||'Start typing and choose yours from the list.';
  toggle.textContent=manual?'Search the list instead':'I can’t find mine';
  if(manual){input.removeAttribute('role');input.removeAttribute('aria-autocomplete');input.removeAttribute('aria-controls');input.removeAttribute('aria-expanded');}
  else{input.setAttribute('role','combobox');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-controls',listId);input.setAttribute('aria-expanded','false');}
 };
 input.addEventListener('input',()=>{
  if(manual){onChange();return;}
  if(picked&&input.value!==picked.name)picked=null;
  onChange();clearTimeout(timer);timer=setTimeout(look,200);
 });
 toggle.addEventListener('click',()=>{manual=!manual;picked=null;sequence++;clearTimeout(timer);close();status.textContent='';if(!manual)input.value='';mode();onChange();input.focus?.();});
 mode();
 if(picked)status.textContent=`Chosen: ${picked.name}`;
 const wrap=h('div',{className:'field lookup'},h('label',{htmlFor:id},h('span',{text:field.label}),optional),help,input,status,list,toggle,error);
 return {field,error,wrap,inputs:[input],marks:[input],
  // Typed letters count only once a match is chosen, unless the patient is typing the name themselves.
  read:()=>manual?input.value.trim():picked?picked.name:'',
  extra:field.id_key?{key:field.id_key,read:()=>!manual&&picked?picked.id:''}:null,
  problem:()=>!manual&&!picked&&input.value.trim()?'Please choose a match from the list, or choose “I can’t find mine”.':''};
}
function intakeControl(field,value,onChange){
 const id='q-'+field.key,helpId=field.help?id+'-help':null,errorId=id+'-error',describedBy=[helpId,errorId].filter(Boolean).join(' ');
 const optional=field.required===true?null:h('span',{className:'optional',text:' (optional)'});
 const help=field.help?h('small',{id:helpId,className:'help',text:field.help}):null;
 const error=h('p',{id:errorId,className:'field-error',hidden:true});
 const control={field,error,inputs:[],marks:[],read:()=>''};
 const required=field.required===true?'true':null;
 const common={name:field.key,'aria-describedby':describedBy,on:{change:onChange,input:onChange}};
 if(field.type==='checkbox'){
  const input=h('input',{...common,id,type:'checkbox','aria-required':required,checked:value===true});
  control.inputs=control.marks=[input];control.read=()=>input.checked;
  control.wrap=h('div',{className:'field'},h('label',{className:'check',htmlFor:id},input,h('span',{text:field.label}),optional),help,error);
 }else if(field.type==='select'&&(field.options||[]).length<=INTAKE_RADIO_LIMIT){
  const radios=(field.options||[]).map((option,index)=>h('input',{...common,id:`${id}-${index}`,type:'radio',value:option,checked:value===option}));
  control.inputs=radios;control.read=()=>radios.find(radio=>radio.checked)?.value||'';
  const clear=field.required===true?null:h('button',{type:'button',className:'link',text:'Clear answer',on:{click:()=>{for(const radio of radios)radio.checked=false;onChange();}}});
  control.wrap=h('fieldset',{className:'field choices',role:'radiogroup','aria-required':required,'aria-describedby':describedBy},h('legend',{},h('span',{text:field.label}),optional),help,...radios.map((radio,index)=>h('label',{className:'choice',htmlFor:radio.id},radio,h('span',{text:intakeOptionLabel(field,field.options[index])}))),clear,error);
 }else{
  let input;
  if(field.type==='select'){
   input=h('select',{...common,id},h('option',{value:'',text:'Choose…'}),...(field.options||[]).map(option=>h('option',{value:option,text:intakeOptionLabel(field,option)})));
   input.value=typeof value==='string'&&(field.options||[]).includes(value)?value:'';
  }else if(field.type==='textarea')input=h('textarea',{...common,id,rows:4,value:typeof value==='string'?value:''});
  else input=h('input',{...common,id,type:field.type==='phone'?'tel':['date','email','number'].includes(field.type)?field.type:'text',value:typeof value==='string'?value:''});
  if(field.type==='number')input.setAttribute('step','any');
  if(field.type!=='select'&&field.type!=='date'){const limit=Math.min(field.type==='textarea'?10000:1000,Number(field.max_length)||Infinity);input.setAttribute('maxlength',String(limit));}
  if(INTAKE_AUTOCOMPLETE.includes(field.autocomplete))input.setAttribute('autocomplete',field.autocomplete);
  if(INTAKE_INPUT_MODES.includes(field.inputmode))input.setAttribute('inputmode',field.inputmode);
  if(required)input.setAttribute('aria-required','true');
  control.inputs=control.marks=[input];control.read=()=>String(input.value??'').trim();
  control.wrap=h('div',{className:'field'},h('label',{htmlFor:id},h('span',{text:field.label}),optional),help,input,error);
 }
 // A group of choices is marked as a whole; a single box or field is marked itself.
 if(!control.marks.length)control.marks=[control.wrap];
 return control;
}
function intakeWizard(packet,token){
 const template=packet.template||{sections:[]},draft=packet.draft&&typeof packet.draft==='object'?packet.draft:null;
 // Progress can be saved until the form has been sent in once.
 const state={answers:{...(draft||{})},screen:'step',sectionIndex:0,controls:[],editing:false,canSave:['sent','in_progress'].includes(packet.status),busy:false,attestedName:'',attested:false};
 const title=q('intake-title'),context=q('intake-context'),body=q('intake-body'),actions=q('intake-actions'),form=q('intake-form'),summary=q('intake-errors'),savedHint=q('intake-saved'),result=q('result');
 const layout=()=>intakeLayout(template,state.answers);
 const given=packet.patient?.given_name||'',practice=packet.practice_name||'your practice';
 // Each new screen is announced from its heading and starts at the top, with the step count in view.
 let opened=false;
 const focusTitle=()=>{title.focus?.({preventScroll:true});if(opened)q('practice-name').scrollIntoView?.({block:'start'});opened=true;};
 function progress(position,total,label){
  const nav=q('intake-progress');nav.hidden=false;q('intake-step-count').textContent=label;
  const bar=q('intake-bar');bar.max=total;bar.value=position;bar.setAttribute('aria-valuetext',label);
  const {steps}=layout();
  q('intake-step-list').replaceChildren(...steps.map((step,index)=>h('li',{'aria-current':state.screen==='step'&&index===position-1?'step':null,text:step.section.label})),h('li',{'aria-current':state.screen==='review'?'step':null,text:'Check your answers'}));
 }
 function collect(){for(const control of state.controls){state.answers[control.field.key]=control.read();if(control.extra)state.answers[control.extra.key]=control.extra.read();}}
 const lookup=(kind,query)=>request('/api/public/v1/intake/lookup',{method:'POST',body:JSON.stringify({token,kind,query})});
 function showErrors(errors){
  let first=null;
  for(const control of state.controls){
   const message=control.wrap.hidden?'':errors[control.field.key]||'';
   control.error.textContent=message;control.error.hidden=!message;
   for(const node of control.marks){if(message)node.setAttribute('aria-invalid','true');else node.removeAttribute('aria-invalid');}
   if(message&&!first)first=control;
  }
  const count=Object.keys(errors).length;
  summary.textContent=count?(count===1?'Please fix the answer marked below.':`Please fix the ${count} answers marked below.`):'';
  first?.inputs[0]?.focus?.();
  return !first;
 }
 // Questions that depend on an earlier answer on the same step appear as soon as that answer is given.
 function refresh(){
  collect();
  const {shown}=layout();
  for(const control of state.controls){const visible=shown.has(control.field.key);control.wrap.hidden=!visible;if(!visible){control.error.hidden=true;control.error.textContent='';}}
 }
 async function save(){
  if(!state.canSave)return true;
  try{await request('/api/public/v1/intake/save',{method:'POST',body:JSON.stringify({token,answers:intakeResponse(template,state.answers)})});savedHint.textContent='Saved';return true;}
  catch(error){
   if(error.status===404||error.status===429){summary.textContent=error.message;return false;}
   if(error.status===409){state.canSave=false;return true;}
   savedHint.textContent='We could not save your progress just now. Your answers are still on this page.';return true;
  }
 }
 function renderStep(sectionIndex,errors=null){
  const {steps}=layout();
  let at=steps.findIndex(step=>step.index>=sectionIndex);if(at<0){renderReview();return;}
  const step=steps[at],section=step.section;
  state.screen='step';state.sectionIndex=step.index;
  title.textContent=section.label;context.textContent=section.intro||'';context.hidden=!section.intro;summary.textContent='';result.textContent='';result.className='';
  progress(at+1,steps.length,`Step ${at+1} of ${steps.length}`);
  // Every question on the step is built; ones that do not apply yet stay hidden.
  const changed=()=>{savedHint.textContent='';refresh();};
  state.controls=(section.fields||[]).filter(field=>field.hidden!==true).map(field=>field.lookup?intakeLookupControl(field,state.answers[field.key],field.id_key?state.answers[field.id_key]:'',changed,lookup):intakeControl(field,state.answers[field.key],changed));
  body.replaceChildren(...state.controls.map(control=>control.wrap));
  const back=at>0||state.editing?h('button',{type:'button',className:'secondary',text:state.editing?'Back to your answers':'Back',on:{click:()=>{collect();if(state.editing){state.editing=false;renderReview();}else renderStep(steps[at-1].index);}}}):null;
  const skip=section.skippable===true?h('button',{type:'button',className:'secondary',text:section.skip_label||'Skip this step',on:{click:()=>run(async()=>{for(const field of section.fields||[])delete state.answers[field.key];if(!await save())return;advance(step.index);})}}):null;
  actions.replaceChildren(...[back,skip,h('button',{type:'submit',className:'primary',text:'Continue'})].filter(Boolean));
  form.hidden=false;refresh();
  if(errors)showErrors(errors);else focusTitle();
 }
 function advance(fromIndex){
  if(state.editing){
   // A changed answer can open a step that has not been filled in yet.
   const open=layout().steps.find(step=>Object.keys(intakeStepErrors(step,state.answers)).length);
   if(open){renderStep(open.index);return;}
   state.editing=false;renderReview();return;
  }
  const next=layout().steps.find(step=>step.index>fromIndex);
  if(next)renderStep(next.index);else renderReview();
 }
 async function continueStep(){
  collect();
  const step=layout().steps.find(item=>item.index===state.sectionIndex);
  const errors=step?intakeStepErrors(step,state.answers):{};
  // Letters typed into a pick-from-list question do not count until a match is chosen.
  for(const control of state.controls){const message=control.wrap.hidden?'':control.problem?.();if(message)errors[control.field.key]=message;}
  if(!showErrors(errors))return;
  if(!await save())return;
  advance(state.sectionIndex);
 }
 function renderReview(){
  const {steps}=layout();
  state.screen='review';state.controls=[];
  title.textContent='Check your answers';context.hidden=false;context.textContent='Please look over your answers. You can change any of them before you send.';summary.textContent='';
  progress(steps.length,steps.length,'Last step: check and send');
  const groups=steps.map(step=>h('section',{className:'review-group'},h('div',{className:'review-head'},h('h2',{text:step.section.label}),h('button',{type:'button',className:'link','aria-label':`Edit ${step.section.label}`,text:'Edit',on:{click:()=>{state.editing=true;renderStep(step.index);}}})),h('dl',{},...step.fields.filter(field=>field.hidden!==true).flatMap(field=>[h('dt',{text:field.label}),h('dd',{className:intakeEmpty(state.answers[field.key])&&field.type!=='checkbox'?'empty':null,text:intakeAnswerText(field,state.answers[field.key])})]))));
  const name=h('input',{id:'attested-name',name:'attested_name',autocomplete:'name',maxlength:200,'aria-required':'true','aria-describedby':'attested-name-error',value:state.attestedName,on:{input:()=>{state.attestedName=name.value;}}});
  const agree=h('input',{id:'attested',name:'attested',type:'checkbox','aria-required':'true','aria-describedby':'attested-error',checked:state.attested,on:{change:()=>{state.attested=agree.checked;}}});
  state.attest={name,agree,nameError:h('p',{id:'attested-name-error',className:'field-error',hidden:true}),agreeError:h('p',{id:'attested-error',className:'field-error',hidden:true})};
  const attestation=h('section',{className:'attestation'},h('h2',{text:'Confirm and send'}),h('p',{text:template.attestation||''}),h('div',{className:'field'},h('label',{className:'check',htmlFor:'attested'},agree,h('span',{text:'I confirm these answers are complete and correct as far as I know.'})),state.attest.agreeError),h('div',{className:'field'},h('label',{htmlFor:'attested-name'},h('span',{text:'Type your full name'})),name,state.attest.nameError));
  body.replaceChildren(...groups,attestation);
  const last=steps[steps.length-1];
  actions.replaceChildren(...[last?h('button',{type:'button',className:'secondary',text:'Back',on:{click:()=>renderStep(last.index)}}):null,h('button',{type:'submit',className:'primary',text:'Send to the practice'})].filter(Boolean));
  form.hidden=false;focusTitle();
 }
 async function send(){
  const {steps}=layout();
  // Changing an answer can open a step that was never filled in.
  for(const step of steps){const errors=intakeStepErrors(step,state.answers);if(Object.keys(errors).length){state.editing=true;renderStep(step.index,errors);return;}}
  const {name,agree,nameError,agreeError}=state.attest,missingName=!name.value.trim(),missingAgree=!agree.checked;
  agreeError.textContent=missingAgree?'Please tick this box to confirm your answers.':'';agreeError.hidden=!missingAgree;
  nameError.textContent=missingName?'Please type your full name.':'';nameError.hidden=!missingName;
  for(const [input,bad] of [[agree,missingAgree],[name,missingName]]){if(bad)input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid');}
  if(missingAgree||missingName){summary.textContent='Please confirm your answers and type your name.';(missingAgree?agree:name).focus?.();return;}
  summary.textContent='';result.className='';result.textContent='Sending your answers…';
  try{
   await request('/api/public/v1/intake/submit',{method:'POST',body:JSON.stringify({token,response:intakeResponse(template,state.answers),attested_name:name.value.trim(),attested:true})});
   renderDone();
  }catch(error){result.textContent='';summary.textContent=error.message;}
 }
 function renderDone(){
  state.screen='done';form.hidden=true;body.replaceChildren();actions.replaceChildren();q('intake-progress').hidden=true;savedHint.textContent='';summary.textContent='';
  try{sessionStorage.removeItem('intake-token');}catch{/* private browsing */}
  title.textContent=given?`Thank you, ${given}`:'Thank you';context.hidden=false;context.textContent=`Your answers were sent to ${practice}.`;
  result.className='done';result.replaceChildren(h('h2',{text:'What happens next'}),h('ul',{},h('li',{text:'The practice will look over your answers before your visit.'}),h('li',{text:'You do not need to do anything else right now.'}),h('li',{text:'If something changes, tell the front desk at your visit.'})),h('p',{text:'You can close this page.'}));
  focusTitle();
 }
 function renderAlreadySent(){
  state.screen='sent';form.hidden=true;q('intake-progress').hidden=true;
  title.textContent='You have already sent this form';context.hidden=false;context.textContent=`${practice} has your answers. You do not need to do anything else.`;
  result.className='';result.replaceChildren(h('p',{text:'Need to change something? You can fill the form in again and send it.'}),h('button',{type:'button',className:'secondary',text:'Fill it in again',on:{click:()=>{result.replaceChildren();renderStep(0);}}}));
 }
 function run(work){if(state.busy)return;state.busy=true;for(const button of actions.children||[])button.disabled=true;Promise.resolve().then(work).catch(error=>{summary.textContent=error.message||'Something went wrong. Please try again.';}).finally(()=>{state.busy=false;for(const button of actions.children||[])button.disabled=false;});}
 form.addEventListener('submit',event=>{event.preventDefault();run(state.screen==='review'?send:continueStep);});
 q('practice-name').textContent=practice;
 if(typeof document.title==='string')document.title=`Patient forms · ${practice}`;
 if(packet.status==='submitted'){renderAlreadySent();return state;}
 const resumeAt=draft?intakeResumeAt(template,state.answers):0,{steps}=layout();
 if(draft&&resumeAt>=steps.length)renderReview();else renderStep(steps[resumeAt]?.index||0);
 if(state.screen==='step'&&resumeAt===0&&!draft){
  const visit=packet.appointment?.starts_at?new Date(packet.appointment.starts_at):null;
  const when=visit&&!Number.isNaN(visit.getTime())?` on ${visit.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})}`:'';
  const intro=steps[0]?.section.intro?' '+steps[0].section.intro:'';
  context.hidden=false;context.textContent=`${given?given+', please':'Please'} fill this in before your visit${when}. It takes about 5 minutes, and your answers are saved as you go.${intro}`;
 }else if(draft){savedHint.textContent='Welcome back. Your earlier answers were saved.';}
 return state;
}
async function intake(){
 const fragment=new URLSearchParams(location.hash.slice(1));let token=fragment.get('token');
 history.replaceState(null,'',location.pathname);
 // The link secret leaves the address bar at once; keeping it for this tab lets a page refresh carry on.
 try{if(token)sessionStorage.setItem('intake-token',token);else token=sessionStorage.getItem('intake-token');}catch{/* private browsing */}
 if(!token)throw new Error('This link is incomplete. Please open the full link the practice sent you, or ask them for a new one.');
 const packet=await request('/api/public/v1/intake/read',{method:'POST',body:JSON.stringify({token})});
 return intakeWizard(packet,token);
}
// Opening the link again in a tab that already shows the form starts over with the new link.
if(typeof addEventListener==='function')addEventListener('hashchange',()=>{if(document.body.dataset.previsitPage==='intake'&&new URLSearchParams(location.hash.slice(1)).get('token'))location.reload();});
document.addEventListener('DOMContentLoaded',()=>{const page=document.body.dataset.previsitPage,run=page==='booking'?booking:intake;run().catch(error=>{if(page!=='booking'){const title=q('intake-title'),context=q('intake-context');if(title)title.textContent='We could not open your forms';if(context)context.textContent='';}q('result').className='error';q('result').textContent=error.message;});},{once:true});
