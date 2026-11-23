// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Small motion helpers. Everything here is decoration: each helper does nothing when the DOM,
// requestAnimationFrame or timers are missing, and none of them delays or blocks anything.
function motionReduced(){try{return typeof matchMedia==='function'&&!!matchMedia('(prefers-reduced-motion: reduce)').matches;}catch{return false;}}
function motionLater(fn,ms){try{if(typeof setTimeout==='function')return setTimeout(fn,ms);}catch{}return null;}
function motionClassOnce(node,name,ms){
 if(!node||!node.classList||motionReduced())return;
 try{
  node.classList.remove(name);
  if(typeof node.offsetWidth==='number')void node.offsetWidth;
  node.classList.add(name);
  const clear=()=>{try{node.classList.remove(name);}catch{}};
  if(typeof node.addEventListener==='function')node.addEventListener('animationend',clear,{once:true});
  motionLater(clear,ms);
 }catch{}
}
function motionIn(node){motionClassOnce(node,'motion-in',600);}
function motionFlash(node){motionClassOnce(node,'motion-flash',1200);}
function motionMarkDone(node){motionClassOnce(node,'motion-just-done',600);}
// Counts a money figure from one amount to another and always ends on the final text.
function motionCount(node,fromCents,toCents){
 if(!node)return;
 const format=typeof money==='function'?money:c=>String(c/100);
 const final=()=>{node.textContent=format(toCents);};
 const from=Number(fromCents),to=Number(toCents);
 if(!Number.isFinite(from)||!Number.isFinite(to)||from===to||typeof requestAnimationFrame!=='function'||motionReduced()){final();return;}
 const total=260;let start=null,finished=false;
 const finish=()=>{if(!finished){finished=true;final();}};
 const step=now=>{
  if(finished)return;
  if(start===null)start=now;
  const t=Math.min(1,(now-start)/total);
  if(t>=1){finish();return;}
  const eased=1-Math.pow(1-t,3);
  node.textContent=format(Math.round(from+(to-from)*eased));
  requestAnimationFrame(step);
 };
 try{requestAnimationFrame(step);}catch{final();return;}
 // A hidden tab pauses frames; the figure must still end on the real amount.
 motionLater(finish,total+120);
}
function skeletonMarkup(kind){
 const bar=cls=>`<span class="skeleton ${cls}" aria-hidden="true"></span>`;
 let body;
 if(kind==='tiles')body=bar('skeleton-tile').repeat(4);
 else if(kind==='card')body=bar('skeleton-heading')+bar('skeleton-line').repeat(3);
 else{kind='rows';body=bar('skeleton-row').repeat(4);}
 return `<div class="skeleton-group" data-skeleton="${kind}" role="status"><span class="sr-only">Loading</span>${body}</div>`;
}
// The toast: success clears itself after four seconds, an error stays until it is dismissed.
let motionNoticeTimer=null;
function motionNotice(node,error){
 if(!node)return;
 try{
  node.setAttribute?.('role',error?'alert':'status');node.setAttribute?.('aria-live',error?'assertive':'polite');
  if(motionNoticeTimer!==null&&typeof clearTimeout==='function')clearTimeout(motionNoticeTimer);
  motionNoticeTimer=null;
  motionClassOnce(node,'toast-in',600);
  if(!error)motionNoticeTimer=motionLater(()=>{motionNoticeTimer=null;node.hidden=true;},4000);
 }catch{}
}
if(typeof document!=='undefined'&&typeof document.addEventListener==='function')document.addEventListener('click',event=>{
 const close=event.target?.closest?.('#notice-close');if(!close)return;
 const node=document.getElementById('notice');if(node)node.hidden=true;
 if(motionNoticeTimer!==null&&typeof clearTimeout==='function')clearTimeout(motionNoticeTimer);motionNoticeTimer=null;
});
