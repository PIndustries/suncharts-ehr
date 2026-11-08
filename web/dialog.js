// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
(function(){
 let active=null,pendingRestore=null;
 const focusableSelector='button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
 const safe=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 function ensureStyle(){
  if(document.getElementById('suncharts-dialog-style'))return;
  const style=document.createElement('style');
  style.id='suncharts-dialog-style';
  style.textContent='#suncharts-dialog-host{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:24px}#suncharts-dialog-host[hidden]{display:none}.app-dialog-backdrop{position:absolute;inset:0;background:#102d34a8;backdrop-filter:blur(3px)}.app-dialog{position:relative;width:min(520px,100%);padding:24px;border:1px solid #cfe0e4;border-radius:16px;background:#fff;box-shadow:0 28px 80px #0b2c3440;color:#183046}.app-dialog header{display:flex;align-items:center;gap:12px}.app-dialog header h2{margin:2px 0 0;font-size:21px}.app-dialog .eyebrow{margin:0;font-size:11px;letter-spacing:.08em}.app-dialog-mark{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;background:#e5f3f1;color:#126e73;font-weight:800}.app-dialog>p{margin:18px 0 0;line-height:1.55}.app-dialog-detail{padding:10px 12px;border-radius:8px;background:#f2f6f7;color:#52687c;font-size:12px}.app-dialog footer{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}.app-dialog footer button{cursor:pointer;border:1px solid #bfd0d5;border-radius:7px;padding:.65rem 1rem;background:#fff;color:#183046;font-weight:700}.app-dialog footer .primary{border-color:#126b70;background:#126b70;color:#fff}.app-dialog.danger .app-dialog-mark{background:#fbeae7;color:#a33f31}.app-dialog footer .primary.danger{border-color:#a33f31;background:#a33f31;color:#fff}@media(max-width:600px){#suncharts-dialog-host{padding:12px;align-items:end}.app-dialog{padding:20px;border-radius:16px 16px 8px 8px}.app-dialog footer{display:grid;grid-template-columns:1fr 1fr}.app-dialog footer button{width:100%}}';
  document.head.append(style);
 }
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
  current.resolve(Boolean(result));
 }
 function confirmAction(message,options={}){
  if(options.signal?.aborted)return Promise.resolve(false);
  ensureStyle();
  if(active)close(false);
  pendingRestore=null;
  const host=ensureHost(),restore=document.activeElement;
  host.hidden=false;
  host.innerHTML=`<div class="app-dialog-backdrop" data-dialog-cancel></div><section class="app-dialog ${options.tone==='danger'?'danger':''}" role="alertdialog" aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message"><header><span class="app-dialog-mark" aria-hidden="true">${options.tone==='danger'?'!':'?'}</span><div><p class="eyebrow">${safe(options.eyebrow||'CONFIRM ACTION')}</p><h2 id="app-dialog-title">${safe(options.title||'Are you sure?')}</h2></div></header><p id="app-dialog-message">${safe(message)}</p>${options.detail?`<p class="app-dialog-detail">${safe(options.detail)}</p>`:''}<footer><button type="button" data-dialog-cancel>${safe(options.cancelLabel||'Cancel')}</button><button type="button" class="primary ${options.tone==='danger'?'danger':''}" data-dialog-confirm>${safe(options.confirmLabel||'Continue')}</button></footer></section>`;
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
