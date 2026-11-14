// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic DOM fixtures exercise the real sign handler in web/app.js; no browser or network.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const read=name=>fs.readFileSync(path.join(__dirname,'../web',name),'utf8');
const app=read('app.js'),style=read('style.css');
const note={subjective:'Synthetic subjective',objective:'Synthetic objective',assessment:'Synthetic assessment',plan:'Synthetic plan'};
// A chart is staged so the real sign handler runs: billing accounts, chart-area and
// resource-visibility stubs, and canned API replies — every path outside the sign flow fails loudly.
function fixture({role='clinician',accounts=[],billingVisible=true,billingAllowed=true}={}){
  const nodes=new Map(),listeners=new Map(),requests=[],asked=[],sections=[];
  function node(id){
    if(nodes.has(id))return nodes.get(id);
    let html='';
    const n={id,hidden:false,disabled:false,isConnected:true,dataset:{},value:'',textContent:'',className:'',
      classList:{add(){},remove(){},contains:()=>false,toggle(){}},
      setAttribute(){},removeAttribute(){},addEventListener(){},replaceChildren(){this.innerHTML='';},
      querySelector(){return null;},querySelectorAll(){return [];},focus(){},scrollIntoView(){},append(){}};
    Object.defineProperty(n,'innerHTML',{get:()=>html,set(value){html=value;if(id==='visit-editor')parseEditor(value);else if(id!=='encounter-progress')parseChart(value);}});
    nodes.set(id,n);return n;
  }
  function parseEditor(html){
    for(const [id,old] of [...nodes])if(id!=='visit-editor'&&(id.startsWith('note-')||id.endsWith('-form'))){old.isConnected=false;nodes.delete(id);}
    for(const [,attributes,id] of html.matchAll(/<(?:div|p|button|span)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const n=node(id);n.hidden=/\shidden(?=[\s>]|$)/.test(attributes);}
    for(const match of html.matchAll(/<form id="([^"]+)"([^>]*)>([\s\S]*?)<\/form>/g)){
      const [,id,attributes,body]=match,form=node(id);form.values={};form.elements={};
      for(const [,key,value]of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g))form.dataset[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
      for(const input of body.matchAll(/<(input|textarea)\b([^>]*\bname="([^"]+)"[^>]*)>([^<]*)/g)){
        const [,tag,attrs,name,text]=input;form.values[name]=tag==='textarea'?text:(attrs.match(/value="([^"]*)"/)?.[1]??'');
        form.elements[name]={get value(){return form.values[name];},set value(value){form.values[name]=value;}};
      }
    }
  }
  function parseChart(html){
    // The encounter heading nests divs, so cut at the next panel rather than the first close.
    const progress=(html.match(/<div id="encounter-progress">([\s\S]*?)<div id="encounter-start-editor">/)?.[1]??'').replace(/<\/div>\s*$/,'');
    if(progress)node('encounter-progress').innerHTML=progress;
  }
  const known=id=>id==='visit-editor'||id==='chart'||id==='encounter-progress'||!(id.startsWith('note-')||id.endsWith('-form'));
  const context=vm.createContext({console,Date,Intl,URL,URLSearchParams,TextEncoder,JSON,Math,Array,Object,String,Number,Boolean,Set,Map,Promise,encodeURIComponent,
    crypto:{randomUUID:()=>'synthetic-request'},location:{search:'',hash:'',pathname:'/'},
    FormData:class{constructor(form){this.form=form;}*[Symbol.iterator](){yield*Object.entries(this.form.values||{});}},
    document:{documentElement:{classList:{add(){},remove(){}}},getElementById:id=>known(id)?node(id):nodes.get(id)||null,querySelectorAll:()=>[],addEventListener(type,callback){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(callback);}},
    window:{scrollTo(){},addEventListener(){}},fetch(){throw new Error('Unexpected network request');},
    confirmAction:async(message,options)=>{asked.push({message,options});return true;},
    localStorage:{setItem(){throw new Error('PHI must not be persisted');}},sessionStorage:{setItem(){throw new Error('PHI must not be persisted');}}});
  vm.runInContext(app,context);
  // Signing needs all four note sections filled, and the reminder asks the encounter
  // account whether charges are posted; both live in deferred modules this chart omits.
  vm.runInContext([
    "noteMissingForSign=form=>noteSectionKeys.slice(0,4).filter(key=>!String(form?.elements[key]?.value??'').trim());",
    "refuseVisitNoteSigning=(form,missing)=>{const host=$('note-message');if(host)host.textContent='Fill in '+missing.join(', ')+' before signing.';};",
    "encounterChargeAccount=()=>(workspace?.billing?.accounts||[]).find(a=>a.status!=='void'&&String(a.content?.visit_id||'')===activeVisit?.id)||null;",
  ].join("\n"),context);
  Object.assign(context,{testNodes:nodes,testRequests:requests,testSections:sections,
    // Step clicks are logged inside the sandbox; keep the log as plain host data.
    record:(...entry)=>sections.push(JSON.parse(JSON.stringify(entry))),
    testRefresh:()=>vm.runInContext("{const panel=$('encounter-progress');if(panel&&workspace&&activeVisit)panel.innerHTML=postSignReminderMarkup()+encounterWorkflow();}",context)});
  vm.runInContext(`api=async(path,method='GET',body,version)=>{testRequests.push(JSON.parse(JSON.stringify({path,method,body,version})));
    if(path==='/api/v1/visits/visit-1/sign'&&method==='POST')return {...activeVisit,status:'signed',version:activeVisit.version+1,signed_at:'2026-11-14T10:00:00Z'};
    throw new Error('Unexpected request '+path);};
    selectPatient=async(patient,keep)=>{record('selectPatient',keep);};
    setEncounterSection=key=>{record('section',key);testRefresh();};
    showChartSection=key=>record('chart',key);
    notice=message=>record('notice',message);
    workspaceResourceAllowed=resource=>resource!=='billing'||${billingAllowed};
    workspaceChartTabEnabled=key=>key!=='billing'||${billingVisible};
    me={tenant_id:'tenant-1',user_id:'author',role:${JSON.stringify(role)}};selected='patient-1';
    workspace={appointments:[{id:'appointment-1',title:'Synthetic visit',starts_at:'2026-11-14T09:00:00Z'}],visits:[],amendments:[],billing:{accounts:${JSON.stringify(accounts)},coverages:[],copays:[],entries:[]}};
    activeVisit={id:'visit-1',patient_id:selected,appointment_id:'appointment-1',clinician_id:'author',status:'in_progress',version:1,note:${JSON.stringify(note)},vitals:null};
    workspace.visits=[activeVisit];renderVisit(false);
    // Chart-only modules are not loaded here; provide the encounter-card hook renderVisit calls.
    if(typeof renderEncounterRevenue!=='function')renderEncounterRevenue=()=>{};`,context);
  const settle=async()=>{for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done));};
  async function click(dataset){
    const button={id:'',type:'button',dataset,closest:()=>null,hasAttribute:()=>false};
    for(const callback of listeners.get('click')||[])callback({target:{closest:()=>button}});
    await settle();
  }
  return {context,nodes,requests,asked,sections,settle,click,
    progress:()=>nodes.get('encounter-progress')?.innerHTML||'',
    reminder:()=>nodes.get('encounter-progress')?.innerHTML?.match(/<div id="sign-charge-reminder"[\s\S]*?<\/div>/)?.[0]||'',
    signedReminder:()=>JSON.parse(vm.runInContext('JSON.stringify(typeof postSignReminder==="undefined"?null:postSignReminder)',context))};
}
async function main(){
  // Signed with nothing posted and billing visible: the reminder appears with a working link.
  let f=fixture();
  await f.click({action:'sign'});
  assert.ok(f.requests.some(r=>r.method==='POST'&&r.path==='/api/v1/visits/visit-1/sign'),'the note is signed');
  let reminder=f.reminder();
  assert.match(reminder,/role="status"/,'the reminder is announced but never blocks');
  assert.match(reminder,/No charges are posted for this visit yet\./);
  assert.equal(reminder.match(/<span>([\s\S]*?)<\/span>/)?.[1],'No charges are posted for this visit yet.','the reminder is the plain sentence, with no alarm prefix');
  assert.match(reminder,/data-encounter-section="charges"[^>]*>Open Procedures &amp; billing<\/button>/,'the link goes to the encounter\u2019s Procedures & billing step');
  assert.doesNotMatch(reminder,/\$|cents|amount/i,'the reminder names no money');
  const steps=f.sections.map(([kind,key])=>`${kind}:${key}`);
  assert.ok(steps.includes('section:charges'),'billing staff still land on the charges step after signing');
  assert.ok(steps.some(s=>s.startsWith('notice:')),'the ordinary signed notice still shows');
  // Clicking the link uses the real step handler.
  f.sections.length=0;
  await f.click({encounterSection:'charges'});
  assert.deepEqual(f.sections.filter(([kind])=>kind==='section'),[['section','charges']]);
  console.log('PASS signing with nothing posted shows a reminder linked to Procedures & billing');

  // The reminder survives chart re-renders for the same visit and reopens with it.
  f.context.renderChart?null:null;
  f.context.testRender=null;
  await f.settle();
  assert.ok(f.reminder(),'the reminder stays while the signed visit is open');

  // Charges already posted: nothing to remind about.
  f=fixture({accounts:[{id:'account-1',status:'posted',content:{visit_id:'visit-1'}}]});
  await f.click({action:'sign'});
  assert.ok(f.requests.some(r=>r.path==='/api/v1/visits/visit-1/sign'),'signing is unchanged');
  assert.equal(f.reminder(),'','posted charges raise no reminder');
  console.log('PASS posted charges raise no reminder');

  // A void account is not posted: the reminder still shows.
  f=fixture({accounts:[{id:'account-1',status:'void',content:{visit_id:'visit-1'}}]});
  await f.click({action:'sign'});
  assert.match(f.reminder(),/No charges are posted for this visit yet\./);
  // A draft account is not posted either.
  f=fixture({accounts:[{id:'account-1',status:'draft',content:{visit_id:'visit-1',total_cents:12000}}]});
  await f.click({action:'sign'});
  assert.match(f.reminder(),/No charges are posted for this visit yet\./,'draft charges are not posted charges');
  // Another visit posted does not silence this one.
  f=fixture({accounts:[{id:'account-1',status:'posted',content:{visit_id:'visit-other'}}]});
  await f.click({action:'sign'});
  assert.match(f.reminder(),/No charges are posted for this visit yet\./);
  console.log('PASS void, draft and another visit\u2019s account do not silence the reminder');

  // Users who cannot see billing see no reminder and no charges link.
  for(const [label,options] of [['billing hidden by the practice workspace',{billingVisible:false}],['billing not allowed for the role',{billingAllowed:false}]]){
    f=fixture(options);
    await f.click({action:'sign'});
    assert.ok(f.requests.some(r=>r.path==='/api/v1/visits/visit-1/sign'),label+': signing still works');
    assert.equal(f.reminder(),'',label+': no reminder without billing visibility');
    assert.doesNotMatch(f.progress(),/sign-charge-reminder|Procedures & billing/,label+': no charges wording anywhere');
    assert.ok(f.sections.some(([kind])=>kind==='notice'),label+': the signed confirmation still shows');
  }
  console.log('PASS no reminder for staff who cannot see billing');

  // Only the note's own visit gets the reminder: opening another encounter retires it.
  f=fixture();
  await f.click({action:'sign'});
  assert.match(f.reminder(),/No charges are posted/);
  vm.runInContext('postSignReminder=null',f.context);f.context.renderVisit(false);await f.settle();
  assert.equal(f.reminder(),'','clearing the reminder removes it on the next render');
  f=fixture();
  await f.click({action:'sign'});
  assert.equal(f.signedReminder()?.visitId,'visit-1');
  vm.runInContext('postSignReminder.visitId="visit-other"',f.context);f.context.renderVisit(false);await f.settle();
  assert.equal(f.reminder(),'','a reminder recorded for another visit never renders');
  console.log('PASS the reminder belongs to the signed visit and retires cleanly');

  // Styling for the linked reminder uses theme variables only, so dark mode follows the theme.
  const rules=style.split('\n').filter(line=>line.startsWith('.notice-with-action')).join('\n');
  assert.ok(rules.includes('.notice-with-action{'),'the linked reminder has its own layout rule');
  assert.doesNotMatch(rules,/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i,'theme variables only, so dark mode follows the theme');
  console.log('PASS reminder styles use theme variables only');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
