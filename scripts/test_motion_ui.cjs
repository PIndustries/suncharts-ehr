// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// The motion helpers are decoration: they must never throw without a DOM, never need
// requestAnimationFrame, and always end a counted amount on the exact final text.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('web/motion.js','utf8'),app=fs.readFileSync('web/app.js','utf8');
const noticeSrc=app.match(/function notice\(message, error = false\) \{[^\n]*\}\n/)[0];
function sandbox(extra={}){
 const ctx={money:c=>'$'+(c/100).toFixed(2),...extra};vm.createContext(ctx);vm.runInContext(src,ctx);return ctx;
}
// skeletons
const bare=sandbox();
for(const kind of['rows','card','tiles']){
 const html=bare.skeletonMarkup(kind);
 assert.match(html,/role="status"/);assert.match(html,/<span class="sr-only">Loading<\/span>/);assert.match(html,new RegExp(`data-skeleton="${kind}"`));
}
assert.equal((bare.skeletonMarkup('rows').match(/skeleton-row/g)||[]).length,4);
assert.equal((bare.skeletonMarkup('tiles').match(/skeleton-tile/g)||[]).length,4);
// no DOM at all
const node={textContent:''};
assert.doesNotThrow(()=>{bare.motionIn(node);bare.motionIn(null);bare.motionFlash(node);bare.motionFlash(undefined);bare.motionNotice(null,false);});
bare.motionCount(node,100,2500);assert.equal(node.textContent,'$25.00');
bare.motionCount(null,1,2);
// reduced motion: final text immediately, even with a frame function
let frames=0;const reduced=sandbox({matchMedia:()=>({matches:true}),requestAnimationFrame:()=>{frames++;}});
const n2={textContent:'',classList:{add(){throw new Error('no class when reduced');},remove(){}}};
reduced.motionCount(n2,0,12345);assert.equal(n2.textContent,'$123.45');assert.equal(frames,0);
assert.doesNotThrow(()=>{reduced.motionIn(n2);reduced.motionFlash(n2);});
// a fake frame driver ends exactly on the final amount
const queue=[];const timers=[];
const live=sandbox({requestAnimationFrame:f=>queue.push(f),setTimeout:(f,ms)=>{timers.push([f,ms]);return timers.length;},clearTimeout:()=>{}});
const n3={textContent:''};live.motionCount(n3,1000,9999);
let t=0;const seen=[];
while(queue.length&&t<100){const f=queue.shift();f(t*20);seen.push(n3.textContent);t++;}
assert.equal(n3.textContent,'$99.99');assert.ok(seen.length>2,'animates over several frames');
// frames that never arrive still end on the final amount through the fallback timer
const n4={textContent:''};const stalled=sandbox({requestAnimationFrame:()=>{},setTimeout:(f,ms)=>{timers.push([f,ms]);return 1;}});
timers.length=0;stalled.motionCount(n4,0,500);timers.forEach(([f])=>f());assert.equal(n4.textContent,'$5.00');
// notice
const els={notice:{textContent:'',className:'',hidden:true,attrs:{},setAttribute(k,v){this.attrs[k]=v;}}};
const pending=[];let cleared=0;
const nctx=sandbox({$:id=>els[id],setTimeout:(f,ms)=>{pending.push([f,ms]);return pending.length;},clearTimeout:()=>{cleared++;}});
vm.runInContext(noticeSrc,nctx);
nctx.notice('Payment saved');
assert.equal(els.notice.textContent,'Payment saved');assert.equal(els.notice.className,'notice');assert.equal(els.notice.hidden,false);
assert.equal(els.notice.attrs.role,'status');
const clear=pending.find(([,ms])=>ms===4000);assert.ok(clear,'success clears after four seconds');clear[0]();assert.equal(els.notice.hidden,true);
pending.length=0;nctx.notice('Could not save',true);
assert.equal(els.notice.className,'notice error');assert.equal(els.notice.hidden,false);assert.equal(els.notice.attrs.role,'alert');
assert.equal(pending.some(([,ms])=>ms===4000),false,'an error stays until dismissed');
// a new message replaces the old timer
nctx.notice('one');nctx.notice('two');assert.ok(cleared>=1);
// notice still works when motion.js is not loaded
const lone={notice:{textContent:'',className:'',hidden:true}};const bareNotice=vm.createContext({$:id=>lone[id]});vm.runInContext(noticeSrc,bareNotice);bareNotice.notice('Hi',true);assert.equal(lone.notice.className,'notice error');
// registered
const index=fs.readFileSync('web/index.html','utf8');assert.match(index,/href="\/motion\.css"/);assert.match(index,/src="\/motion\.js"/);
const css=fs.readFileSync('web/motion.css','utf8');assert.match(css,/prefers-reduced-motion:reduce/);assert.doesNotMatch(css,/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/);
console.log('PASS motion helpers, skeletons and toast');
