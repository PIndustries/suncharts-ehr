// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// One patient picker, used wherever a staff member has to name a patient: booking an
// appointment, attaching a patient to a support request, or finding someone on the day
// board. Results appear while the person types, so no screen needs a Search or Find button.
//
// A picker owns one text box and the patient it stands for. It writes the patient ID to a
// hidden input, so the surrounding form still submits `patient_id` exactly as before.

const patientPickerLimit=8,patientPickerDelayMs=200,patientPickerPages=8;
const patientPickers=new Map();
// The patient list is the same page for every picker on the screen, so one read serves them
// all instead of asking the server once per picker.
const patientPickerReads=new Map();
let patientPickerSequences=0;

const patientPickerText=value=>String(value??'').trim().toLowerCase();
const patientPickerDay=value=>String(value??'').slice(0,10);
const patientPickerLabel=patient=>`${patient.family_name}, ${patient.given_name}`;
const patientPickerAge=patient=>typeof displayAge==='function'?displayAge(patient.birth_date):null;

// What one line in the list says: name and age, then the record number, so two patients
// with the same name stay easy to tell apart.
function patientPickerRowHtml(patient){
  const age=patientPickerAge(patient);
  return `<span>${esc(patientPickerLabel(patient))}</span><small>${age===null?'Age not recorded':`${age} years old`} · MRN ${esc(patient.mrn)}</small>`;
}
function patientPickerRowLabel(patient){
  const age=patientPickerAge(patient);
  return `${patientPickerLabel(patient)} · ${age===null?'age not recorded':`${age} years old`} · MRN ${patient.mrn}`;
}
// Name, record number, or a date of birth typed as a date. Every part of the query has to
// match something, so "rey 1980-04" narrows a list instead of quietly finding nothing.
function patientPickerMatches(patient,query){
  const parts=patientPickerText(query).split(/\s+/).filter(Boolean);
  if(!parts.length)return true;
  const haystack=[patientPickerLabel(patient),patientPickerText(patient.given_name),patientPickerText(patient.family_name),patientPickerText(patient.mrn),patientPickerDay(patient.birth_date)].filter(Boolean).join(' ');
  return parts.every(part=>haystack.includes(part));
}
function patientPickerEndpoint(picker,after){
  const options=picker.options;
  if(typeof options.endpoint==='function')return options.endpoint(after);
  if(typeof options.endpoint==='string')return options.endpoint;
  return typeof options.directoryQuery==='function'?options.directoryQuery(after):'/api/v1/patients';
}
async function patientPickerPage(picker,after){
  const key=patientPickerEndpoint(picker,after),identity=me;
  if(!patientPickerReads.has(key)){
    const request=api(key).catch(error=>{
      // A failed read is not a result; forget it so the next keystroke can try again.
      if(patientPickerReads.get(key)===request)patientPickerReads.delete(key);
      throw error;
    });
    patientPickerReads.set(key,request);
  }
  const page=await patientPickerReads.get(key);
  // Nobody who signed out mid-read gets a patient list drawn in their place.
  if(identity&&me!==identity)throw new Error('sign in changed');
  return {items:Array.isArray(page?.items)?page.items:[],cursor:page?.next_cursor||null};
}
function patientPickerItems(picker,query){
  return picker.patients.filter(patient=>patientPickerMatches(patient,query)).slice(0,patientPickerLimit);
}
function patientPickerStatus(picker){
  if(picker.error)return picker.error;
  if(picker.busy)return 'Searching…';
  if(picker.chosen)return '';
  const query=String(picker.query||'').trim();
  if(patientPickerCanCreate(picker))return 'No patient matches. Choose New patient to register them here.';
  if(!picker.items.length)return query?'No patient matches yet. Keep typing, or check the spelling.':'No patients have been registered yet.';
  if(!query)return `Showing the first ${picker.items.length}. Start typing to find someone faster.`;
  return `${picker.items.length===1?'One patient matches':`${picker.items.length} patients match`}. Keep typing to narrow the list, or use the up and down arrow keys.`;
}
// The list itself, plus the quiet "Load more" that reaches the next page when a short list
// is being browsed with nothing typed yet.
function patientPickerCanCreate(picker){return !!picker.options.oncreate&&!picker.busy&&!picker.error&&!picker.items.length&&!!String(picker.query||'').trim();}
function patientPickerListHtml(picker){
  const rows=picker.items.map((patient,index)=>`<button type="button" class="patient-picker-row${index===picker.active?' is-active':''}" role="option" aria-selected="${index===picker.active}" id="${picker.listId}-option-${index}" data-patient-picker-option="${index}">${patientPickerRowHtml(patient)}</button>`).join('');
  const browsing=!String(picker.query||'').trim();
  const more=picker.cursor&&browsing?`<button type="button" class="quiet patient-picker-more" data-patient-picker-more>Load more patients</button>`:'';
  const create=patientPickerCanCreate(picker)?`<button type="button" class="patient-picker-row" data-patient-picker-create>+ New patient '${esc(picker.query.trim())}'</button>`:'';
  return `${rows||create||'<p class="muted patient-picker-none">Type a name, a date of birth or a record number.</p>'}${more}`;
}
function renderPatientPicker(picker){
  if(!picker.input?.isConnected)return;
  picker.items=patientPickerItems(picker,picker.query);
  if(picker.active>=picker.items.length)picker.active=picker.items.length-1;
  picker.input.setAttribute('aria-expanded',String(!picker.popup.hidden&&Boolean(picker.items.length||patientPickerCanCreate(picker))));
  picker.list.innerHTML=patientPickerListHtml(picker);
  picker.status.textContent=patientPickerStatus(picker);
  if(picker.active<0)picker.input.removeAttribute('aria-activedescendant');
  else{
    picker.input.setAttribute('aria-activedescendant',`${picker.listId}-option-${picker.active}`);
    const row=picker.list.querySelector(`[data-patient-picker-option="${picker.active}"]`);
    if(row){const top=row.offsetTop,bottom=top+row.offsetHeight;if(top<picker.list.scrollTop)picker.list.scrollTop=top;else if(bottom>picker.list.scrollTop+picker.list.clientHeight)picker.list.scrollTop=bottom-picker.list.clientHeight;}
  }
}
function openPatientPicker(picker){if(picker.input?.isConnected)picker.popup.hidden=false;renderPatientPicker(picker);}
function closePatientPicker(picker){
  if(!picker.input?.isConnected)return;
  picker.popup.hidden=true;picker.list.innerHTML='';picker.status.textContent='';picker.active=-1;
  picker.input.setAttribute('aria-expanded','false');picker.input.removeAttribute('aria-activedescendant');picker.input.removeAttribute('aria-busy');
}
function patientPickerChoose(picker,patient){
  if(!patient||!picker.input?.isConnected)return false;
  picker.chosen=patient.id;picker.field.value=patient.id;
  picker.input.value=patientPickerRowLabel(patient);
  picker.query='';picker.error='';picker.active=-1;picker.busy=false;
  renderPatientPicker(picker);closePatientPicker(picker);
  picker.input.dispatchEvent(new Event('change',{bubbles:true}));
  if(picker.onchoose)picker.onchoose(patient);
  return true;
}
// The plain Clear beside the box: it empties the answer and puts the caret back, so staff
// never need a second "Find" step to start again.
function patientPickerClear(picker){
  picker.chosen=null;picker.field.value='';picker.input.value='';picker.query='';picker.error='';picker.active=-1;
  renderPatientPicker(picker);openPatientPicker(picker);picker.input.focus({preventScroll:true});
  if(picker.onchoose)picker.onchoose(null);
}
function patientPickerChosenStillMatches(picker){
  const patient=picker.patients.find(item=>item.id===picker.chosen);
  return patient?patientPickerMatches(patient,picker.query):false;
}
// Enter and Tab choose when exactly one patient matches; otherwise Enter moves down the
// list, so a staff member can walk to the right person without leaving the box.
function patientPickerEnter(picker){
  if(picker.busy||!picker.items.length)return false;
  if(picker.items.length===1)return patientPickerChoose(picker,picker.items[0]);
  if(patientPickerChosenStillMatches(picker))return false;
  if(picker.active>=0&&picker.items[picker.active])return patientPickerChoose(picker,picker.items[picker.active]);
  return false;
}
async function patientPickerRunSearch(picker,sequence,query){
  try{
    const first=await patientPickerPage(picker,null);
    picker.cursor=first.cursor;
    let items=first.items,cursor=first.cursor;
    // With nothing typed yet the box shows a short list. When the first page holds no match
    // for what was typed, later pages are read too, so a search is not limited to page one.
    if(!patientPickerItems({...picker,patients:items},query).length&&cursor){
      items=[...items];
      for(let page=0;page<patientPickerPages&&cursor;page++){
        const next=await patientPickerPage(picker,cursor);
        items.push(...next.items);cursor=next.cursor;
        if(patientPickerItems({...picker,patients:items},query).length)break;
      }
    }
    if(sequence!==picker.sequence)return;
    picker.patients=items;picker.cursor=cursor;picker.error='';
    openPatientPicker(picker);
  }catch{
    if(sequence!==picker.sequence)return;
    // A failed page still leaves the earlier patients on screen; only the note changes.
    picker.error='Patient names could not be loaded right now. Try again in a moment; your other answers are kept.';
    openPatientPicker(picker);
  }
}
// "Load more patients" brings the next page into the list that is already showing.
function readPatientPickerPage(picker){
  const cursor=picker.cursor;if(!cursor)return;
  picker.sequence++;
  picker.busy=true;picker.error='';
  if(picker.input.isConnected)picker.input.setAttribute('aria-busy','true');
  const done=()=>{picker.busy=false;picker.input.removeAttribute('aria-busy');renderPatientPicker(picker);};
  patientPickerPage(picker,cursor).then(page=>{
    picker.patients=[...picker.patients,...page.items];picker.cursor=page.cursor;
  },()=>{}).then(done,done);
}
function patientPickerSearch(picker,query){
  const sequence=++picker.sequence;
  picker.error='';picker.busy=true;
  if(picker.input.isConnected)picker.input.setAttribute('aria-busy','true');
  const done=()=>{
    if(sequence!==picker.sequence)return;
    picker.busy=false;picker.input.removeAttribute('aria-busy');
    renderPatientPicker(picker);
  };
  patientPickerRunSearch(picker,sequence,query).then(done,done);
}
function schedulePatientPicker(picker,query,immediate=false){
  clearTimeout(picker.timer);picker.timer=null;
  if(immediate){patientPickerSearch(picker,query);return;}
  picker.timer=setTimeout(()=>{picker.timer=null;patientPickerSearch(picker,query);},patientPickerDelayMs);
}
// A single match is accepted as soon as it is there: the answer goes in and the list closes,
// so typing a full record number ends with the patient chosen, not with a list of one.
function patientPickerAutoAccept(picker){
  if(picker.busy||String(picker.query||'').trim().length<2)return;
  if(picker.chosen&&patientPickerChosenStillMatches(picker))return;
  if(picker.items.length===1)patientPickerChoose(picker,picker.items[0]);
}
function patientPickerType(picker,value){
  picker.query=String(value??'');
  // Editing the box means the earlier choice no longer stands until it is matched again.
  if(picker.chosen){picker.chosen=null;picker.field.value='';}
  // What is on screen keeps showing while the next search runs: nothing blanks out.
  renderPatientPicker(picker);
  schedulePatientPicker(picker,picker.query,String(picker.query).trim().length<2);
}
function patientPickerStep(picker,direction){
  if(!picker.items.length)return;
  picker.active=(picker.active+direction+picker.items.length)%picker.items.length;
  renderPatientPicker(picker);
}
// Wiring is installed once for the whole application; a screen only renders its own box.
function installPatientPickers(){
  if(patientPickers.__installed)return;
  patientPickers.__installed=true;
  const pickerOf=node=>{
    const host=node?.closest?.('[data-patient-picker]');
    return host&&patientPickers.get(host.dataset.patientPicker)||null;
  };
  document.addEventListener('input',event=>{
    if(event.target.matches?.('[data-patient-picker-input]')&&!event.isComposing)patientPickerType(pickerOf(event.target),event.target.value);
  });
  document.addEventListener('compositionend',event=>{if(event.target.matches?.('[data-patient-picker-input]'))patientPickerType(pickerOf(event.target),event.target.value);});
  document.addEventListener('focusin',event=>{
    const picker=pickerOf(event.target);if(!picker||event.target!==picker.input)return;
    openPatientPicker(picker);
    // A box that already holds a chosen patient needs no new read until it is typed in.
    if(!picker.patients.length&&!picker.chosen)schedulePatientPicker(picker,picker.query,true);
  });
  document.addEventListener('focusout',event=>{
    const picker=pickerOf(event.target);if(!picker||event.target!==picker.input)return;
    if(event.relatedTarget?.closest?.('[data-patient-picker-create]'))return;
    // Leaving the box takes the only match, so tabbing through a form still chooses.
    if(!picker.busy&&!picker.chosen)patientPickerEnter(picker);
    closePatientPicker(picker);
  });
  document.addEventListener('keydown',event=>{
    const picker=pickerOf(event.target);if(!picker||event.target!==picker.input||event.isComposing)return;
    if(event.key==='Escape'){if(!picker.popup.hidden){event.preventDefault();event.stopImmediatePropagation();closePatientPicker(picker);}return;}
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();event.stopImmediatePropagation();
      if(picker.popup.hidden||!picker.items.length)schedulePatientPicker(picker,picker.query,true);
      else patientPickerStep(picker,event.key==='ArrowDown'?1:-1);
      return;
    }
    if(event.key==='Enter'){
      if(patientPickerCanCreate(picker)){event.preventDefault();event.stopImmediatePropagation();picker.options.oncreate(picker.query.trim(),picker);return;}
      // Enter either chooses or steps through; it never submits a booking half-finished.
      if(patientPickerEnter(picker)||picker.popup.hidden)event.preventDefault();
      else if(!picker.busy&&picker.items.length){patientPickerStep(picker,1);event.preventDefault();}
      event.stopImmediatePropagation();
    }
  });
  document.addEventListener('mousedown',event=>{if(event.target.closest?.('[data-patient-picker-create]'))event.preventDefault();});
  document.addEventListener('click',event=>{
    const picker=pickerOf(event.target);if(!picker)return;
    if(event.target.closest?.('[data-patient-picker-create]')&&patientPickerCanCreate(picker)){event.preventDefault();event.stopImmediatePropagation();picker.options.oncreate(picker.query.trim(),picker);return;}
    if(event.target.closest?.('[data-patient-picker-clear]')){event.preventDefault();event.stopImmediatePropagation();patientPickerClear(picker);return;}
    if(event.target.closest?.('[data-patient-picker-more]')){
      event.preventDefault();event.stopImmediatePropagation();
      if(picker.cursor)readPatientPickerPage(picker);
      return;
    }
    const row=event.target.closest?.('[data-patient-picker-option]');if(!row)return;
    event.preventDefault();event.stopImmediatePropagation();
    patientPickerChoose(picker,picker.items[Number(row.dataset.patientPickerOption)]);
  });
}
// The picker's own markup. It carries no patient data of its own: a text box, a hidden ID
// for the form to submit, and the list that fills in as the person types. `value` pre-fills a
// patient ID the form already holds.
function patientPickerMarkup(options){
  installPatientPickers();
  const id=`patient-picker-${++patientPickerSequences}`,listId=`${id}-list`;
  patientPickers.set(id,{
    id,listId,options,input:null,field:null,list:null,status:null,popup:null,rows:[],
    patients:[],cursor:null,items:[],active:-1,query:'',chosen:null,error:'',busy:false,timer:null,sequence:0,
    onchoose:options.onchoose||null,
  });
  return `<div class="patient-picker" data-patient-picker="${esc(id)}"><label for="${esc(id)}-input">${esc(options.label||'Patient')}</label><div class="patient-picker-field"><input id="${esc(id)}-input" class="patient-picker-input" type="search" data-patient-picker-input autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="${esc(listId)}" aria-describedby="${esc(id)}-status" placeholder="${esc(options.placeholder||'Name, date of birth or record number')}" value="${esc(options.value||'')}"${options.required?' required':''}><button type="button" class="quiet patient-picker-clear" data-patient-picker-clear>Clear</button></div><input type="hidden" name="${esc(options.name||'patient_id')}" data-patient-picker-field value="${esc(options.value||'')}"><div class="patient-picker-suggestions" data-patient-picker-popup hidden><p id="${esc(id)}-status" class="patient-picker-status" data-patient-picker-status role="status" aria-live="polite"></p><div class="patient-picker-list" id="${esc(listId)}" role="listbox" aria-label="${esc(options.listLabel||'Matching patients')}" data-patient-picker-list></div></div></div>`;
}
// A form that already has the patient keeps it: the name in plain words, nothing to type.
function patientPickerPinnedMarkup(options){
  const patient=options.patient||{},age=patientPickerAge(patient);
  return `<div class="patient-picker patient-picker-pinned"><span class="muted">${esc(options.label||'Patient')}</span><p><b>${esc(patientPickerLabel(patient))}</b> · ${age===null?'Age not recorded':`${age} years old`} · MRN ${esc(patient.mrn)}</p><input type="hidden" name="patient_id" value="${esc(patient.id)}"></div>`;
}
// The box is in the page; connect its parts to the picker that drives it.
function mountPatientPicker(host){
  // The picker is the box that holds the search input. A form around it can carry an attribute of
  // the same name for its own use (the patient to start with), so the box is found from its input
  // first; taking the form for the picker left the box unconnected and the list never opened.
  const inner=host?.querySelector?.('[data-patient-picker-input]')?.closest?.('[data-patient-picker]');
  const root=inner||host?.closest?.('[data-patient-picker]')||host?.querySelector?.('[data-patient-picker]')||host;
  const id=root?.dataset?.patientPicker,picker=id&&patientPickers.get(id);if(!picker)return null;
  if(root.dataset.patientPickerMounted==='1')return picker;
  const input=root.querySelector('[data-patient-picker-input]'),field=root.querySelector('[data-patient-picker-field]'),popup=root.querySelector('[data-patient-picker-popup]');
  if(!input||!field||!popup)return null;
  Object.assign(picker,{host:root,input,field,popup,list:popup.querySelector('[data-patient-picker-list]'),status:popup.querySelector('[data-patient-picker-status]')});
  root.dataset.patientPickerMounted='1';
  return picker;
}
