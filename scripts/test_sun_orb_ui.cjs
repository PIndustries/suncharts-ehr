// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/sun-orb.js','utf8');
const positionKey='suncharts.sun.position.v1';
function harness({saved=null,storageFails=false,viewport=true}={}){
 const nodes=new Map(),events={},windowEvents={},viewportEvents={},timers=new Map(),microtasks=[],observers=[],writes=[],status=[],calls={open:0,close:0,stop:0,cancel:0,page:0,chat:0};
 let now=0,timerId=0,context;
 const storage=new Map(saved===null?[]:[[positionKey,saved]]);
 const register=node=>{if(node.id)nodes.set(node.id,node);for(const child of node.children)register(child);};
 const unregister=node=>{if(node.id)nodes.delete(node.id);for(const child of node.children)unregister(child);};
 class Element{
  constructor(tag='div',id=''){this.tagName=tag.toUpperCase();this.id=id;this.children=[];this.parentElement=null;this.dataset={};this.style={};this.attributes={};this.hidden=false;this.textContent='';this.focused=false;this.captures=[];const classes=new Set();this.classList={add:(...v)=>v.forEach(c=>classes.add(c)),remove:(...v)=>v.forEach(c=>classes.delete(c)),contains:v=>classes.has(v)};}
  get offsetWidth(){return this.id==='sun-presence'?100:68;}
  get offsetHeight(){return this.id==='sun-presence'?128:68;}
  get firstChild(){return this.children[0]||null;}
  get innerHTML(){return this.markup||'';}
  set innerHTML(value){for(const child of this.children)unregister(child);this.children=[];this.markup=value;for(const match of value.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/g)){const id=match[2].match(/\bid="([^"]+)"/)?.[1];if(!id)continue;const child=new Element(match[1],id);for(const attr of match[2].matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/g))child.setAttribute(attr[1],attr[2]);child.hidden=/\bhidden(?:\s|$)/.test(match[2]);this.append(child);}}
  append(...children){for(const child of children){if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(v=>v!==child);child.parentElement=this;this.children.push(child);register(child);}}
  insertAdjacentElement(where,child){assert.equal(where,'afterend');const parent=this.parentElement;assert.ok(parent);if(child.parentElement)child.parentElement.children=child.parentElement.children.filter(v=>v!==child);child.parentElement=parent;parent.children.splice(parent.children.indexOf(this)+1,0,child);register(child);}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(v=>v!==this);this.parentElement=null;unregister(this);}
  setAttribute(key,value){this.attributes[key]=String(value);if(key==='class')this.classList.add(...String(value).split(/\s+/));}
  getAttribute(key){return this.attributes[key]??null;}
  querySelector(selector){const matches=child=>selector.startsWith('.')?child.classList.contains(selector.slice(1)):child.tagName.toLowerCase()===selector;return this.children.find(matches)||this.children.map(child=>child.querySelector(selector)).find(Boolean)||null;}
  focus(){this.focused=true;}
  scrollIntoView(options){this.scrolled=options;}
  setPointerCapture(id){this.captures.push(id);}
  click(event={detail:0}){this.onclick?.(event);}
 }
 const body=new Element('body'),app=new Element('main','app'),header=new Element('header','workspace-header');body.append(app);app.append(header);header.classList.add('workspace-header');
 const node=(id,parent=body)=>{const element=new Element('div',id);parent.append(element);return element;};
 node('page-title',header).textContent='Schedule';node('shell-loading').hidden=true;node('notice').hidden=true;
 node('nav-schedule');node('nav-clinical');node('nav-workflows');
 const panel=node('sun-panel');panel.hidden=true;const panelHeader=node('sun-panel-header',panel);panelHeader.tagName='HEADER';node('sun-close',panelHeader);const modeLabel=node('sun-mode-label',panel);node('sun-mode',modeLabel);node('sun-provider-label',panel);const textLabel=node('sun-text-label',panel);node('sun-text',textLabel);node('sun-examples',panel);node('sun-patient-context-area',panel);node('sun-privacy-preview',panel).hidden=true;const controls=node('sun-controls',panel);controls.classList.add('sun-controls');node('sun-send',controls);node('sun-page-root',app);node('sun-status',panel).textContent='Ready.';node('sun-answer',panel).hidden=true;
 const privacy=node('sun-privacy-guide',panel),privacyContent=node('synthetic-privacy-content',privacy);
 const visualViewport=viewport?{width:800,height:600,offsetLeft:0,offsetTop:0,addEventListener:(type,handler)=>(viewportEvents[type]??=[]).push(handler)}:undefined;
 const window={innerWidth:800,innerHeight:600,visualViewport,addEventListener:(type,handler)=>(windowEvents[type]??=[]).push(handler),speechSynthesis:{speaking:false,cancel(){calls.cancel++;this.speaking=false;}}};
 class MutationObserver{constructor(callback){this.callback=callback;this.targets=[];this.disconnected=false;observers.push(this);}observe(target,options){this.targets.push({target,options});}disconnect(){this.disconnected=true;this.targets=[];}}
 context=vm.createContext({console,JSON,Object,Number,Math,String,window,MutationObserver,localStorage:{getItem:key=>{if(storageFails)throw Error('blocked');return storage.get(key)??null;},setItem:(key,value)=>{if(storageFails)throw Error('blocked');storage.set(key,value);writes.push({key,value});}},document:{body,createElement:tag=>new Element(tag),querySelector:selector=>selector==='#app .workspace-header'?header:null,querySelectorAll:selector=>selector==='.sun-guided-target'?[...nodes.values()].filter(v=>v.classList.contains('sun-guided-target')):[],addEventListener:(type,handler)=>(events[type]??=[]).push(handler)},$:id=>nodes.get(id)||null,me:{role:'owner'},sunListening:false,sunBusy:false,sunPrivacyReview:null,sunNavigation:{schedule:'nav-schedule',patients:'nav-clinical',workflows:'nav-workflows'},sunInvalidatePrivacyReview(){context.sunPrivacyReview=null;},sunStatus:text=>{status.push(text);const target=nodes.get('sun-status');if(target)target.textContent=text;},stopSunListening(){calls.stop++;context.sunListening=false;},openSun(){calls.open++;panel.hidden=false;context.mountSunWorkspace();},showSunPage(){calls.page++;vm.runInContext("sunPanelView='page'",context);context.mountSunWorkspace();},returnSunToChat(){calls.chat++;vm.runInContext("sunPanelView='chat'",context);context.mountSunWorkspace();},setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,time:now+delay});return id;},clearTimeout:id=>timers.delete(id),queueMicrotask:callback=>microtasks.push(callback)});
 vm.runInContext(source,context);
 nodes.get('sun-close').onclick=()=>{if(context.collapseSunWorkspace()===false)return;calls.close++;panel.hidden=true;};
 const run=code=>vm.runInContext(code,context);
 return {context,nodes,events,windowEvents,viewportEvents,observers,writes,status,calls,storage,window,body,header,panel,privacy,privacyContent,run,
  emit:(type,detail)=>{for(const handler of events[type]||[])handler({detail});},
  flush(){while(microtasks.length)microtasks.shift()();},
  mutate(){for(const observer of observers)if(!observer.disconnected)observer.callback();},
  advance(ms){const end=now+ms;for(;;){const next=[...timers.entries()].filter(([,v])=>v.time<=end).sort((a,b)=>a[1].time-b[1].time)[0];if(!next)break;now=next[1].time;timers.delete(next[0]);next[1].callback();}now=end;},
 };
}
const point=h=>JSON.parse(h.run('JSON.stringify(sunOrbPosition)'));
const approximately=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
function key(button,value){let prevented=false;button.onkeydown({key:value,preventDefault(){prevented=true;}});return prevented;}

// Initial position, bounded storage and drag threshold/capture/click behavior.
let h=harness();h.run('initSunOrb()');let orb=h.nodes.get('sun-presence'),button=h.nodes.get('sun-open');
assert.equal(orb.style.left,'688px');assert.equal(orb.style.top,'460px');assert.equal(h.observers.length,1);h.run('initSunOrb()');assert.equal(h.observers.length,1,'mount is idempotent');
button.onpointerdown({button:2,pointerId:1,clientX:0,clientY:0});assert.equal(h.run('sunOrbDrag'),null);
button.onpointerdown({button:0,pointerId:4,clientX:100,clientY:100});assert.deepEqual(button.captures,[4]);button.onpointermove({pointerId:4,clientX:103,clientY:103});button.onpointerup();assert.equal(h.writes.length,0,'small pointer jitter is not a drag');button.click({detail:1});assert.equal(h.calls.open,1);
button.onpointerdown({button:0,pointerId:5,clientX:100,clientY:100});button.onpointermove({pointerId:6,clientX:-10000,clientY:-10000});assert.deepEqual(point(h),{x:1,y:1});button.onpointermove({pointerId:5,clientX:-10000,clientY:-10000});assert.deepEqual(point(h),{x:0,y:0});assert.equal(orb.style.left,'12px');assert.equal(orb.style.top,'12px');button.onpointerup();assert.equal(h.writes.length,1);assert.deepEqual(JSON.parse(h.writes[0].value),{x:0,y:0});assert.equal(h.writes[0].key,positionKey);button.click({detail:1});assert.equal(h.calls.close,0,'drag completion does not toggle workspace');button.click({detail:0});assert.equal(h.calls.close,1,'keyboard activation is not suppressed by dragging');
button.onpointerdown({button:0,pointerId:7,clientX:0,clientY:0});button.onpointermove({pointerId:7,clientX:10000,clientY:10000});button.onpointercancel();assert.deepEqual(point(h),{x:1,y:1});assert.equal(h.run('sunOrbDrag'),null);assert.equal(h.run('sunOrbSuppressClick'),false);
h=harness({saved:'{"x":-20,"y":30}'});h.run('initSunOrb()');assert.deepEqual(point(h),{x:0,y:1});
h=harness({saved:'{"x":"0.2","y":null}'});h.run('initSunOrb()');assert.deepEqual(point(h),{x:1,y:1});
for(const options of [{saved:'broken JSON'},{storageFails:true}]){h=harness(options);assert.doesNotThrow(()=>h.run('initSunOrb()'));assert.doesNotThrow(()=>key(h.nodes.get('sun-open'),'Home'));}

// Keyboard position persists only numeric coordinates and respects viewport offsets.
h=harness({saved:'{"x":0.5,"y":0.5}'});h.run('initSunOrb()');button=h.nodes.get('sun-open');
assert.equal(key(button,'ArrowLeft'),true);approximately(point(h).x,.45);key(button,'ArrowUp');approximately(point(h).y,.45);key(button,'ArrowRight');key(button,'ArrowDown');approximately(point(h).x,.5);approximately(point(h).y,.5);
for(let index=0;index<30;index++)key(button,'ArrowLeft');assert.equal(point(h).x,0);key(button,'Home');assert.deepEqual(point(h),{x:1,y:1});const writeCount=h.writes.length;assert.equal(key(button,'Enter'),false);assert.equal(h.writes.length,writeCount);
Object.assign(h.window.visualViewport,{width:500,height:400,offsetLeft:30,offsetTop:40});h.viewportEvents.resize[0]();assert.equal(h.nodes.get('sun-presence').style.left,'418px');assert.equal(h.nodes.get('sun-presence').style.top,'300px');h.window.visualViewport.offsetTop=70;h.viewportEvents.scroll[0]();assert.equal(h.nodes.get('sun-presence').style.top,'330px');
h=harness({viewport:false});h.run('initSunOrb()');h.window.innerWidth=600;h.windowEvents.resize[0]();assert.equal(h.nodes.get('sun-presence').style.left,'488px');

// The collapsed orb exposes current work and an always-reachable voice stop.
h=harness();h.run('initSunOrb()');orb=h.nodes.get('sun-presence');button=h.nodes.get('sun-open');
assert.equal(orb.dataset.state,'idle');assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(h.nodes.get('sun-orb-stop').hidden,true);
for(const [state,setup,label] of [
 ['ready',()=>{h.nodes.get('sun-answer').hidden=false;},'Draft ready'],
 ['approval',()=>{h.context.sunPrivacyReview={id:'synthetic-preview'};},'Review needed'],
 ['working',()=>{h.context.sunBusy={};},'Working'],
 ['speaking',()=>{h.window.speechSynthesis.speaking=true;},'Speaking'],
 ['listening',()=>{h.context.sunListening=true;},'Listening'],
]){setup();h.run('updateSunOrb()');assert.equal(orb.dataset.state,state);assert.equal(h.nodes.get('sun-orb-label').textContent,label);assert.equal(button.getAttribute('aria-expanded'),'false');}
assert.equal(h.nodes.get('sun-orb-stop').hidden,false);assert.equal(h.nodes.get('sun-orb-stop').textContent,'Stop microphone');h.nodes.get('sun-orb-stop').click();assert.equal(h.calls.stop,1);assert.equal(h.calls.cancel,1);assert.equal(h.context.sunListening,false);assert.equal(h.window.speechSynthesis.speaking,false);assert.equal(h.nodes.get('sun-orb-stop').hidden,true);assert.equal(h.status.at(-1),'Voice stopped.');
h.context.sunBusy=false;h.context.sunPrivacyReview=null;h.nodes.get('sun-answer').dataset.origin='local';h.run('updateSunOrb()');assert.equal(h.nodes.get('sun-orb-label').textContent,'Answer ready');h.nodes.get('sun-answer').dataset.origin='provider';h.run('updateSunOrb()');assert.equal(h.nodes.get('sun-orb-label').textContent,'Draft ready');
h.context.sunBusy=false;h.context.sunPrivacyReview=null;h.window.speechSynthesis.speaking=true;h.run('updateSunOrb()');assert.equal(h.nodes.get('sun-orb-stop').textContent,'Stop speaking');h.nodes.get('sun-orb-stop').click();
button.click({detail:1});assert.equal(h.panel.hidden,false);assert.equal(button.getAttribute('aria-expanded'),'true');assert.equal(h.panel.parentElement,h.body);assert.ok(h.panel.classList.contains('sun-floating-chat'));assert.equal(h.panel.scrolled,undefined,'opening floating chat never scrolls the underlying page');assert.equal(h.nodes.get('page-title').textContent,'Schedule');assert.equal(h.nodes.get('sun-mode-label').parentElement.className,'sun-settings-body');assert.equal(h.nodes.get('sun-answer').parentElement.id,'sun-conversation');assert.equal(h.nodes.get('sun-text-label').parentElement.id,'sun-composer');const details=h.privacy.querySelector('details');assert.ok(details);assert.equal(h.privacyContent.parentElement,details);h.run('mountSunWorkspace()');assert.equal(h.privacy.children.filter(child=>child.tagName==='DETAILS').length,1);button.click({detail:1});assert.equal(h.panel.hidden,true);assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(button.focused,true);assert.ok(h.nodes.has('sun-presence'),'collapsing retains the orb');h.nodes.get('sun-guide-dismiss').click();assert.equal(h.nodes.get('sun-workspace-guide').hidden,true);

// Floating placement is viewport bounded, with the same component on the separate Sun page.
h=harness();h.run('initSunOrb()');h.nodes.get('sun-open').click({detail:1});
assert.equal(h.panel.style.width,'460px');assert.equal(h.panel.style.height,'576px');assert.equal(h.panel.style.left,'214px');assert.equal(h.panel.style.top,'12px');
Object.assign(h.window.visualViewport,{width:360,height:480,offsetLeft:20,offsetTop:30});h.viewportEvents.resize[0]();
assert.equal(h.panel.style.width,'336px');assert.equal(h.panel.style.height,'456px');assert.equal(h.panel.style.left,'32px');assert.equal(h.panel.style.top,'42px');
const transcript=h.nodes.get('sun-text');transcript.value='Unsaved synthetic question';const settings=h.nodes.get('sun-settings');
h.nodes.get('sun-expand-page').click();assert.equal(h.calls.page,1);assert.equal(h.run('sunPanelView'),'page');assert.equal(h.panel.parentElement,h.nodes.get('sun-page-root'));assert.ok(h.panel.classList.contains('sun-page-workspace'));assert.equal(h.panel.style.left,'');assert.equal(h.panel.style.width,'');assert.equal(h.nodes.get('sun-expand-page').getAttribute('aria-label'),'Return to floating chat');assert.equal(h.nodes.get('sun-text'),transcript);assert.equal(transcript.value,'Unsaved synthetic question');
h.nodes.get('sun-expand-page').click();assert.equal(h.calls.chat,1);assert.equal(h.panel.parentElement,h.body);assert.equal(h.nodes.get('sun-settings'),settings,'switching view preserves control identity');assert.ok(h.panel.classList.contains('sun-floating-chat'));
h.nodes.get('sun-expand-page').click();h.nodes.get('sun-close').click();assert.equal(h.run('sunPanelView'),'chat');assert.equal(h.panel.hidden,true);assert.equal(h.panel.parentElement,h.body);assert.equal(h.nodes.get('sun-open').focused,true,'closing the full Sun page returns focus to the persistent orb');

// A refused page return keeps the same visible panel; switching presentation invalidates a pending preview.
h=harness();h.run('initSunOrb()');h.nodes.get('sun-open').click({detail:1});h.context.sunPrivacyReview={id:'review'};h.nodes.get('sun-expand-page').click();assert.equal(h.context.sunPrivacyReview,null);assert.match(h.status.at(-1),/workspace context changed/);h.context.returnSunToChat=()=>false;h.nodes.get('sun-close').click();assert.equal(h.panel.hidden,false);assert.equal(h.panel.parentElement,h.nodes.get('sun-page-root'));assert.equal(h.run('sunPanelView'),'page');

// Navigation requires both the requested active tab and finished loading.
h=harness();h.run('initSunOrb()');h.nodes.get('shell-loading').hidden=false;h.emit('suncharts:sun-navigation',{target:'nav-schedule'});h.flush();assert.equal(h.status.length,0);
h.nodes.get('shell-loading').hidden=true;h.mutate();assert.equal(h.status.length,0,'loaded unrelated workspace is not completion');h.nodes.get('nav-schedule').setAttribute('aria-current','page');h.nodes.get('shell-loading').hidden=false;h.mutate();assert.equal(h.status.length,0,'active but loading workspace is not completion');h.nodes.get('shell-loading').hidden=true;h.mutate();assert.equal(h.status.at(-1),'Schedule is open. You can continue here.');assert.ok(h.nodes.get('page-title').classList.contains('sun-guided-target'));h.advance(3500);assert.equal(h.nodes.get('page-title').classList.contains('sun-guided-target'),false);const completedStatus=h.status.length;h.advance(15000);assert.equal(h.status.length,completedStatus,'successful completion cancels the pending timeout');
h.nodes.get('page-title').textContent='Patients';h.run('updateSunOrb()');assert.equal(h.nodes.get('sun-status').textContent,'Ready in this workspace.');
h=harness();h.run('initSunOrb()');h.nodes.get('nav-schedule').setAttribute('aria-current','page');h.nodes.get('notice').hidden=false;h.nodes.get('notice').classList.add('error');h.emit('suncharts:sun-navigation',{target:'nav-schedule'});h.flush();assert.match(h.status.at(-1),/could not finish loading/);assert.equal(h.run('sunOrbNavigation'),null);
h=harness();h.run('initSunOrb()');h.emit('suncharts:sun-navigation',{target:'nav-schedule'});h.flush();h.advance(14999);assert.equal(h.status.length,0);h.advance(1);assert.match(h.status.at(-1),/has not finished opening/);h.nodes.get('nav-schedule').setAttribute('aria-current','page');h.mutate();assert.equal(h.status.length,1,'late completion cannot replace the timeout outcome');
h.emit('suncharts:sun-navigation',{target:'unknown-action'});assert.equal(h.run('sunOrbNavigation'),null);

// Logout cleanup removes UI, observers and pending navigation effects.
h=harness();h.run('initSunOrb()');h.emit('suncharts:sun-navigation',{target:'nav-schedule'});h.nodes.get('page-title').classList.add('sun-guided-target');h.run('clearSunOrb()');h.context.me=null;h.flush();h.advance(20000);assert.equal(h.nodes.has('sun-presence'),false);assert.equal(h.nodes.has('sun-open'),false);assert.equal(h.nodes.has('sun-workspace-guide'),false);assert.equal(h.observers[0].disconnected,true);assert.equal(h.nodes.get('page-title').classList.contains('sun-guided-target'),false);assert.equal(h.status.length,0);assert.equal(h.run('sunOrbNavigation'),null);assert.equal(h.run('sunOrbDrag'),null);assert.equal(h.run('sunPanelView'),'chat');assert.doesNotThrow(()=>h.windowEvents.resize[0]());h.run('initSunOrb()');assert.equal(h.nodes.has('sun-presence'),false);h.context.me={role:'patient'};h.run('initSunOrb()');assert.equal(h.nodes.has('sun-presence'),false);h.context.me={role:'owner'};h.run('initSunOrb()');assert.equal(h.nodes.has('sun-presence'),true);assert.equal(h.observers.length,2);
console.log('PASS Sun orb drag/keyboard position, floating/page presentation, collapsed states and voice stop, bound navigation completion/timeout, session cleanup');
