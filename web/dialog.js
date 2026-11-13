// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
(function(){
 let active=null,pendingRestore=null;
 const focusableSelector='button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
 const safe=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 function ensureHost(){
  let host=document.getElementById('suncharts-dialog-host');
  if(host)return host;
  host=document.createElement('div');
  host.id='suncharts-dialog-host';
  document.body.append(host);
  return host;
 }
 function restoreFocus(){
  const target=pendingRestore;
  if(!target)return false;
  if(!target.isConnected||typeof target.focus!=='function'||target.hidden||target.closest?.('[hidden],[aria-hidden="true"]')){pendingRestore=null;return false;}
  if(target.disabled)return false;
  if(typeof target.checkVisibility==='function')try{if(!target.checkVisibility({checkOpacity:false,checkVisibilityCSS:true})){pendingRestore=null;return false;}}catch{}
  target.focus({preventScroll:true});
  if(document.activeElement!==target)return false;
  pendingRestore=null;
  return true;
 }
 function close(result){
  if(!active)return;
  const current=active;
  active=null;
  current.cleanup();
  current.host.replaceChildren();
  current.host.hidden=true;
  pendingRestore=current.restore;
  restoreFocus();
  current.resolve(result==='alternate'?'alternate':Boolean(result));
 }
 function confirmAction(message,options={}){
  if(options.signal?.aborted)return Promise.resolve(false);
  if(active)close(false);
  pendingRestore=null;
  const host=ensureHost(),restore=document.activeElement;
  host.hidden=false;
  host.innerHTML=`<div class="app-dialog-backdrop" data-dialog-cancel></div><section class="app-dialog ${options.tone==='danger'?'danger':''}" role="alertdialog" aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message"><header><span class="app-dialog-mark" aria-hidden="true">${options.tone==='danger'?'!':'?'}</span><div><p class="eyebrow">${safe(options.eyebrow||'CONFIRM ACTION')}</p><h2 id="app-dialog-title">${safe(options.title||'Are you sure?')}</h2></div></header><p id="app-dialog-message">${safe(message)}</p>${options.detail?`<p class="app-dialog-detail">${safe(options.detail)}</p>`:''}<footer><button type="button" data-dialog-cancel>${safe(options.cancelLabel||'Cancel')}</button>${options.alternateLabel?`<button type="button" data-dialog-alternate>${safe(options.alternateLabel)}</button>`:''}<button type="button" class="primary ${options.tone==='danger'?'danger':''}" data-dialog-confirm>${safe(options.confirmLabel||'Continue')}</button></footer></section>`;
  return new Promise(resolve=>{
   const confirm=host.querySelector('[data-dialog-confirm]'),cancel=host.querySelector('button[data-dialog-cancel]');
   const focusables=()=>[...host.querySelectorAll(focusableSelector)];
   const onConfirm=()=>close(true),onCancel=()=>close(false);
   const onKeydown=event=>{
    if(active?.host!==host)return;
    if(event.key==='Escape'){event.preventDefault();close(false);return;}
    if(event.key!=='Tab')return;
    const controls=focusables();
    if(!controls.length)return;
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
   };
   const onFocusin=event=>{
    if(active?.host===host&&!host.contains(event.target))(options.tone==='danger'?cancel:confirm).focus({preventScroll:true});
   };
   const onAbort=()=>{if(active?.host===host)close(false);};
   const cleanup=()=>{
    document.removeEventListener('keydown',onKeydown,true);
    document.removeEventListener('focusin',onFocusin,true);
    options.signal?.removeEventListener('abort',onAbort);
   };
   active={host,resolve,restore,cleanup};
   confirm.addEventListener('click',onConfirm,{once:true});
   // An optional second choice resolves to 'alternate'; confirm stays true and cancel false.
   host.querySelector('[data-dialog-alternate]')?.addEventListener('click',()=>close('alternate'),{once:true});
   host.querySelectorAll('[data-dialog-cancel]').forEach(node=>node.addEventListener('click',onCancel,{once:true}));
   document.addEventListener('keydown',onKeydown,true);
   document.addEventListener('focusin',onFocusin,true);
   options.signal?.addEventListener('abort',onAbort,{once:true});
   const initial=options.initialFocus==='cancel'||options.tone==='danger'?cancel:confirm;
   initial.focus({preventScroll:true});
  });
 }
 window.confirmAction=confirmAction;
 window.SunChartsDialog={confirm:confirmAction,close,restoreFocus};
})();
