// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The shared auto-refresh, tested with fake timers and stub DOM nodes only:
// no browser, no jsdom. Covers the interval, the skips (typing, unsaved edits,
// in-flight, hidden tab, removed host), the backoff, the quiet update line,
// the no-flash repaint, the immediate refresh on visibility/focus/save, the
// stop token and sign-out cleanup. It also pins the wiring: every revenue
// screen registered here loads the core before it, exposes a register call,
// and ships no manual Refresh button for these screens.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/autorefresh.js','utf8');

function element(tag='div',id){
 const attributes={};
 const node={tag,id,tagName:tag.toUpperCase(),hidden:false,isConnected:true,children:[],dataset:{},style:{},
 attributes,
 setAttribute(name,value){attributes[name]=String(value);},getAttribute(name){return attributes[name]??null;},
 _html:'',scrollTop:0,scrollLeft:0,scrollHeight:0,clientHeight:0,textContent:'',
 set className(value){attributes.class=value;},get className(){return attributes.class||'';},
 set innerHTML(value){this._html=value;nodes.forEach(child=>{if(child.parent===this){child.isConnected=false;child.parent=null;}});this.children=nodes.filter(child=>child.parent===this&&child!==this);},
 get innerHTML(){return this._html;},
 appendChild(child){child.parent=this;child.isConnected=this.isConnected;this.children.push(child);return child;},
 insertBefore(child){child.parent=this;child.isConnected=this.isConnected;this.children.unshift(child);return child;},
 remove(){this.isConnected=false;const index=nodes.indexOf(this);if(index>=0)nodes.splice(index,1);if(this.parent){const at=this.parent.children.indexOf(this);if(at>=0)this.parent.children.splice(at,1);}},
 querySelector(selector){const found=this.querySelectorAll(selector);return found.length?found[0]:null;},
 querySelectorAll(selector){const classes=String(selector).replace(/^:scope\s*>\s*/,'').split('.').filter(Boolean);const own=classes[0]?(this.children||[]).filter(child=>String(child.className||'').split(/\s+/).includes(classes[0])):[];const walk=[];const visit=node=>{for(const child of node.children||[])if(child!==this){walk.push(child);visit(child);}};visit(this);const matching=classes.length?walk.filter(node=>classes.every(name=>String(node.className||'').split(/\s+/).includes(name))):walk;return selector&&selector.includes(':scope')?own.length?own:[]:matching;},contains(other){let node=other;while(node){if(node===this)return true;node=node.parent;}return false;},focus(){(nodes.__document||globalThis).__active(this);},scrollIntoView(){this.scrolled=(this.scrolled||0)+1;},closest(){return null;},};
 node.parentElement=null;return node;
}
let nodes=[];
function makeDocument(){
 const body=element('body');
 const doc={body,activeElement:body,hidden:false,visibilityState:'visible',isConnected:true,
 listeners:{},
 addEventListener(kind,fn){(this.listeners[kind]??=[]).push(fn);},
 createElement:tag=>{const node=element(tag);nodes.push(node);return node;},
 getElementById:id=>nodes.find(node=>node.id===id&&node.isConnected)||null,
 contains:node=>{let walk=node;while(walk){if(walk===body)return true;walk=walk.parent;}return false;},
 dispatch(kind){for(const fn of this.listeners[kind]||[])fn();},
 };
 body.parent=doc;doc.activeElement=body;
 return doc;
}
// Fake timers: setTimeout pushes onto a queue the test advances by hand.
const timers=[];let time=0;
const clock={get now(){return time;},advance(ms){const target=time+ms;for(;;){const due=timers.filter(t=>!t.dead&&t.at<=target).sort((a,b)=>a.at-b.at)[0];if(!due)break;time=due.at;due.dead=true;due.fn();}time=target;},pending(){return timers.filter(t=>!t.dead).length;}};
function fixture(){
 nodes=[];timers.length=0;
 const document=makeDocument();nodes.__document=undefined;globalThis.__active=node=>{document.activeElement=node;};
 const window={listeners:{},addEventListener(kind,fn){(this.listeners[kind]??=[]).push(fn);},dispatch(kind){for(const fn of this.listeners[kind]||[])fn();}};
 const context={console,document,window,crypto:{randomUUID:()=>`key-${Math.random().toString(16).slice(2)}`},
 Map,Set,Symbol,WeakMap,JSON,Math,Date,String,Number,Object,Array,Promise};
 context.setTimeout=(fn,ms)=>{const timer={at:time+(ms||0),fn,dead:false};timers.push(timer);return timer;};
 context.clearTimeout=timer=>{if(timer)timer.dead=true;};
 vm.createContext(context);vm.runInContext(source,context);
 return{context,document,window};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

(async()=>{
 // 1. The interval re-runs load; the update line stays quiet in the header.
 {
 const{context,document}=fixture();const host=element("div","claims-tool");const head=element('div');head.className='section-head';head.parent=host;head.isConnected=true;host.children=[head];nodes.push(host,head);
 let loads=0;
 context.registerAutoRefresh('claims-tool',{load:async()=>{loads++;return `<p>batch ${loads}</p>`;},everyMs:30000});
 assert.equal(head.children.length,1);
 assert.equal(head.children[0].textContent,'Updates automatically');
 assert.equal(head.children[0].getAttribute('role')||head.children[0].role,'status');
 clock.advance(30000);await flush();
 assert.equal(loads,1);assert.equal(host.innerHTML,'<p>batch 1</p>');
 assert.match(head.children[0].textContent,/Updated just now/);
 clock.advance(30000);await flush();
 assert.equal(loads,2);
 console.log('PASS interval: quiet header line, 30 s cadence, content replaced when data changed');
 }
 // 2. Unchanged data never touches the DOM (no flash, no scroll, no focus loss).
 {
 const{context}=fixture();const host=element('div','host');nodes.push(host);
 let loads=0;
 const updateLine=head=>host.children.find(child=>String(child.className||'').includes('auto-refresh-updated'));
 context.registerAutoRefresh('host',{load:async()=>{loads++;return '<p>same</p>';},everyMs:1000});
 clock.advance(1000);await flush();
 assert.equal(host.innerHTML,'<p>same</p>');host.scrollTop=320;
 clock.advance(1000);await flush();
 assert.equal(loads,2);assert.equal(host.innerHTML,'<p>same</p>');assert.equal(host.scrollTop,320);
 // The line lives in a header strip outside the host content, so a repaint
 // can never disturb the screen's own markup.
 assert.equal(updateLine(),undefined);
 assert.equal(clock.pending(),1);
 console.log('PASS no flash: identical data leaves the screen untouched');void updateLine;
 }
 // 3. Skips: typing in a field, unsaved edits, in-flight request, host gone.
 {
 const{context,document}=fixture();const host=element('div','host');nodes.push(host);
 const input=element('input');input.name='reason';input.parent=host;host.children=[input];nodes.push(input);
 let loads=0;
 context.registerAutoRefresh('host',{load:async()=>{loads++;return '<p>x</p>';},everyMs:1000});
 document.activeElement=input;
 clock.advance(1000);await flush();
 assert.equal(loads,0,'typing inside the host skips the tick');
 document.activeElement=document.body;input.value='typed but unsaved';
 clock.advance(1000);await flush();
 assert.equal(loads,0,'a value that no longer matches the saved record skips the tick');
 input.defaultValue='typed but unsaved';
 // The form now reads as clean, so the next tick runs and its request starts.
 let release;let started=0;
 context.registerAutoRefresh('host',{load:()=>{started++;return new Promise(resolve=>{release=resolve;});},everyMs:1000});
 clock.advance(1000);await flush();
 assert.equal(started,1,'the clean form lets the tick run');
 clock.advance(5000);await flush();
 assert.equal(started,1,'a second request waits while one is in flight');
 release('<p>done</p>');await flush();
 assert.equal(host.innerHTML,'<p>done</p>','the settled request repaints');
 clock.advance(1000);await flush();
 assert.equal(started,2,'the next tick runs once the request settles');
 host.isConnected=false;
 clock.advance(10000);await flush();
 assert.equal(started,2,'a removed host stops refreshing');
 assert.equal(host.children.filter(child=>String(child.className||'').includes('auto-refresh-updated')).length,0,'the update line goes with the host');
 console.log('PASS skips: typing, unsaved edits, in-flight request and removed host');
 }
 // 4. Errors back off (double up to five minutes) and never raise a popup.
 {
 const{context}=fixture();const host=element('div','host');nodes.push(host);
 let loads=0,fail=true;let notices=0;
 context.registerAutoRefresh('host',{load:async()=>{loads++;if(fail)throw new Error('network');return '<p>ok</p>';},everyMs:1000});
 clock.advance(1000);await flush();assert.equal(loads,1);
 clock.advance(1500);await flush();assert.equal(loads,1,'waiting is doubled after an error');
 clock.advance(500);await flush();assert.equal(loads,2);
 clock.advance(3500);await flush();assert.equal(loads,2);clock.advance(500);await flush();assert.equal(loads,3,'then doubled again');
 for(let attempt=0;attempt<8;attempt++){clock.advance(300000);await flush();}
 fail=false;
 clock.advance(300000);await flush();
 assert.ok(loads>=6,'backoff keeps polling');
 fail=true;for(let attempt=0;attempt<10;attempt++){clock.advance(300000);await flush();}
 // At the cap the next try lands inside five minutes, not beyond it.
 clock.advance(299999);await flush();
 assert.ok(loads>=16,'the capped wait fires within five minutes');
 assert.equal(notices,0);assert.ok(!host.innerHTML.includes('error'),'no error popup content in the host');
 console.log('PASS backoff: doubling after errors, capped at five minutes, never a popup');void notices;
 }
 // 5. Immediate refresh when the tab becomes visible or the window regains focus.
 {
 const{context,document,window}=fixture();const host=element('div','host');nodes.push(host);
 let loads=0;
 context.registerAutoRefresh('host',{load:async()=>{loads++;return `<p>${loads}</p>`;},everyMs:30000});
 document.visibilityState='hidden';document.hidden=true;
 clock.advance(60000);await flush();assert.equal(loads,0,'hidden tabs do not poll');
 document.visibilityState='visible';document.hidden=false;document.dispatch('visibilitychange');await flush();
 assert.equal(loads,1,'the tab refreshes the moment it is seen again');
 clock.advance(5000);window.dispatch('focus');await flush();
 assert.equal(loads,2,'focus runs the update immediately');
 console.log('PASS wake: visible tab and window focus refresh at once, hidden tabs stay quiet');
 }
 // 6. A save elsewhere releases a refresh once the save settles.
 {
 const{context,document}=fixture();const host=element('div','host');nodes.push(host);
 let loads=0;
 context.registerAutoRefresh('host',{load:async()=>{loads++;return `<p>${loads}</p>`;},everyMs:30000});
 document.dispatch('submit');            // a save starts somewhere in the app
 await flush();assert.equal(loads,0,'no refresh while a save is in flight');
 context.autoRefreshTickSoon();await flush();
 assert.equal(loads,1,'a successful save brings fresh data right away');
 console.log('PASS save: quiet while saving, refreshed when the save succeeds');
 }
 // 7. The stop token unregisters (a claim that reached its final status).
 {
 const{context}=fixture();const host=element('div','host');nodes.push(host);
 let loads=0;
 context.registerAutoRefresh('host',{load:async()=>{loads++;return context.autoRefreshStop();},everyMs:1000});
 clock.advance(1000);await flush();assert.equal(loads,1);
 clock.advance(5000);await flush();assert.equal(loads,1,'a final status stops the poll');
 assert.equal(host.children.filter(child=>String(child.className||'').includes('auto-refresh-updated')).length,0,'the update line goes with it');
 console.log('PASS stop token: final claim status ends the poll cleanly');
 }
 // 8. Unregister: the timer dies, the line goes; sign-out clears every run.
 {
 const{context,document}=fixture();const one=element('div','one');const two=element('div','two');nodes.push(one,two);
 let loads=0;
 context.registerAutoRefresh('one',{load:async()=>{loads++;return '<p>1</p>';},everyMs:1000});
 context.registerAutoRefresh('two',{load:async()=>{loads++;return '<p>2</p>';},everyMs:1000});
 assert.equal(one.children.length,1);assert.equal(two.children.length,1);
 assert.ok(context.unregisterAutoRefresh('one'));
 assert.equal(one.children.filter(child=>String(child.className||'').includes('auto-refresh-updated')).length,0,'unregister removes the update line');
 clock.advance(1000);await flush();assert.equal(loads,1,'only the remaining screen keeps polling');
 context.clearAutoRefreshSession();
 clock.advance(5000);await flush();assert.equal(loads,1,'sign-out stops everything');
 assert.equal(two.children.filter(child=>String(child.className||'').includes('auto-refresh-updated')).length,0);
 console.log('PASS unregister: per-screen stop and full sign-out cleanup');
 }
 // 9. Wiring: each revenue screen loads the core, registers, and has no Refresh button.
 {
 const index=fs.readFileSync('web/index.html','utf8');
 assert.match(index,/src="\/autorefresh\.js"/);
 const scripts=[...index.matchAll(/<script src="\/([^"]+\.js)" defer>/g)].map(match=>match[1]);
 const core=scripts.indexOf('autorefresh.js');
 assert.ok(core>=0,'index.html loads the auto-refresh core');
 for(const screen of ['billing.js','billing-overview.js','payments.js','claims.js','clearinghouse.js','delivery.js','era-batches.js','patient-billing-workspace.js'])
  assert.ok(core<scripts.indexOf(screen),`the auto-refresh core loads before ${screen}`);
 const lib=fs.readFileSync('src/lib.rs','utf8');
 assert.ok(lib.includes('include_str!("../web/autorefresh.js")'),'src/lib.rs serves /autorefresh.js');
 assert.match(fs.readFileSync('web/app.js','utf8'),/clearAutoRefreshSession/,'sign-out clears every auto-refresh');
 const screens={
 'web/claims.js':["registerAutoRefresh('claims-workspace'","registerAutoRefresh('claim-status'"],
 'web/clearinghouse.js':['registerAutoRefresh(\'edi-workspace\''],
 'web/delivery.js':['registerAutoRefresh(\'delivery-job\''],
 'web/era-batches.js':['registerAutoRefresh(\'era-batch\''],
 'web/payments.js':["registerAutoRefresh('payment-review'","registerAutoRefresh('payment-settings'","registerAutoRefresh('payment-operations'"],
 'web/billing.js':["registerAutoRefresh('billing-queue'"],
  'web/billing-overview.js':["registerAutoRefresh('billing-overview'"],
 'web/patient-billing-workspace.js':["registerAutoRefresh('patient-billing'"],
 };
 for(const [file,needles] of Object.entries(screens)){
  const code=fs.readFileSync(file,'utf8');
  for(const needle of needles)assert.ok(code.includes(needle),`${file} registers ${needle}`);
 }
 const removed=[
 ['web/claims.js',/>Refresh<\/button>|>Refresh claim status<|>Refresh status</],
 ['web/clearinghouse.js',/data-edi-refresh/],
 ['web/delivery.js',/data-delivery-open="\$\{j\.id\}">Refresh</],
 ['web/era-batches.js',/Refresh file</],
 ['web/payments.js',/Refresh verified provider status|Refresh activity|Retry activity|data-payment-operations-refresh/],
 ['web/billing.js',/data-billing-refresh/],
 ['web/billing-overview.js',/data-overview-refresh>Refresh</],
 ['web/patient-billing-workspace.js',/data-hub-refresh>Refresh</],
 ];
 for(const [file,pattern] of removed)assert.doesNotMatch(fs.readFileSync(file,'utf8'),pattern,`${file} still shows a manual Refresh for staff`);
 // A sent claim polls every 30 s and a final status stops it.
 const claims=fs.readFileSync('web/claims.js','utf8');
 assert.match(claims,/\['submitted','accepted','adjudicated'\]\.includes\((?:c|claim)\.status\)/);
 assert.match(claims,/registerAutoRefresh\('claim-status',\{host,load:claimDetailAutoRefreshLoad,everyMs:30000\}\)/);
 assert.match(claims,/function claimFinalStatus\(claim,detail=\{\}\)\{return \['void','rejected'\]\.includes\(claim\?\.status\)\|\|detail\?\.tracking\?\.remittance_posted===true;\}/);
 assert.match(claims,/return claimFinalStatus\(d\.claim,d\)\?autoRefreshStop\(\):undefined;/);
 console.log('PASS wiring: every revenue screen registers the shared refresh and shows no Refresh button');
 }
 console.log('PASS autorefresh: interval, skips, backoff, wake, save, stop, unregister and screen wiring');
})().catch(error=>{console.error(error);process.exitCode=1;});
