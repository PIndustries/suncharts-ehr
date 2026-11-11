// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('web/dialog.js','utf8');
const index=fs.readFileSync('web/index.html','utf8');
const portal=fs.readFileSync('web/patient-portal.html','utf8');
const style=fs.readFileSync('web/style.css','utf8'),portalStyle=fs.readFileSync('web/patient-portal.css','utf8');
const scripts=fs.readdirSync('web').filter(name=>name.endsWith('.js')&&name!=='dialog.js');

class EventTargetFake{
 constructor(){this.listeners=new Map()}
 addEventListener(type,handler,options={}){const items=this.listeners.get(type)||[];items.push({handler,once:options===true?false:!!options.once});this.listeners.set(type,items)}
 removeEventListener(type,handler){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item.handler!==handler))}
 dispatchEvent(event){event.target??=this;event.preventDefault??=()=>{event.defaultPrevented=true};for(const item of [...(this.listeners.get(event.type)||[])]){item.handler(event);if(item.once)this.removeEventListener(event.type,item.handler)}return !event.defaultPrevented}
 listenerCount(type){return(this.listeners.get(type)||[]).length}
}
class ElementFake extends EventTargetFake{
 constructor(tag,document){super();this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.dataset={};this.hidden=false;this.disabled=false;this.isConnected=false;this._id='';this._innerHTML=''}
 set id(value){this._id=value;if(this.isConnected)this.ownerDocument.ids.set(value,this)}get id(){return this._id}
 append(child){this.children.push(child);child.parentNode=this;child.isConnected=true;if(child.id)this.ownerDocument.ids.set(child.id,child);return child}
 replaceChildren(){this.children=[];this._dialogNodes=null;this._innerHTML=''}
 set innerHTML(value){this._innerHTML=value;this.children=[];if(this.id!=='suncharts-dialog-host')return;const backdrop=new ElementFake('div',this.ownerDocument);backdrop.dataset.dialogCancel='';const section=new ElementFake('section',this.ownerDocument);const cancel=new ElementFake('button',this.ownerDocument);cancel.dataset.dialogCancel='';const confirm=new ElementFake('button',this.ownerDocument);confirm.dataset.dialogConfirm='';this.append(backdrop);this.append(section);section.append(cancel);section.append(confirm);this._dialogNodes={backdrop,section,cancel,confirm}}
 get innerHTML(){return this._innerHTML}
 querySelector(selector){if(selector==='[data-dialog-confirm]')return this._dialogNodes?.confirm||null;if(selector==='button[data-dialog-cancel]')return this._dialogNodes?.cancel||null;return null}
 querySelectorAll(selector){if(selector==='[data-dialog-cancel]')return this._dialogNodes?[this._dialogNodes.backdrop,this._dialogNodes.cancel]:[];if(selector.includes('button:not([disabled])'))return this._dialogNodes?[this._dialogNodes.cancel,this._dialogNodes.confirm]:[];return[]}
 contains(node){if(node===this)return true;return !!this._dialogNodes&&Object.values(this._dialogNodes).includes(node)}
 closest(selector){if(selector==='[hidden],[aria-hidden="true"]'){for(let node=this;node;node=node.parentNode)if(node.hidden)return node;}return null}
 checkVisibility(){return !this.closest('[hidden],[aria-hidden="true"]')}
 focus(){if(this.disabled||!this.isConnected||!this.checkVisibility())return;this.ownerDocument.activeElement=this}
 click(){this.dispatchEvent({type:'click'})}
}
class DocumentFake extends EventTargetFake{
 constructor(){super();this.ids=new Map();this.head=new ElementFake('head',this);this.body=new ElementFake('body',this);this.head.isConnected=this.body.isConnected=true;this.activeElement=this.body}
 createElement(tag){assert.notEqual(tag.toLowerCase(),'style','dialogs must use external CSS allowed by the application CSP');return new ElementFake(tag,this)}
 getElementById(id){return this.ids.get(id)||null}
}
const key=(document,value,shiftKey=false)=>document.dispatchEvent({type:'keydown',key:value,shiftKey,defaultPrevented:false});

(async()=>{
 const document=new DocumentFake(),window={};
 vm.runInNewContext(source,{window,document,AbortController,Promise});
 const opener=document.body.append(document.createElement('button'));opener.focus();

 const dangerous=window.confirmAction('<unsafe>',{title:'Delete?',tone:'danger',detail:'Cannot be undone'});
 const host=document.getElementById('suncharts-dialog-host');
 assert.ok(host,'dialog host is created');
 assert.match(host.innerHTML,/role="alertdialog"/);
 assert.match(host.innerHTML,/aria-modal="true"/);
 assert.match(host.innerHTML,/&lt;unsafe&gt;/,'message content is escaped');
 assert.equal(document.activeElement,host._dialogNodes.cancel,'dangerous actions focus Cancel by default');
 assert.equal(document.listenerCount('keydown'),1,'one keyboard trap is installed');
 assert.equal(document.listenerCount('focusin'),1,'one focus guard is installed');

 key(document,'Tab',true);
 assert.equal(document.activeElement,host._dialogNodes.confirm,'Shift+Tab wraps from first to last control');
 key(document,'Tab');
 assert.equal(document.activeElement,host._dialogNodes.cancel,'Tab wraps from last to first control');
 const outside=document.body.append(document.createElement('button'));outside.focus();
 document.dispatchEvent({type:'focusin',target:outside});
 assert.equal(document.activeElement,host._dialogNodes.cancel,'programmatic focus is returned to the active dialog');
 key(document,'Escape');
 assert.equal(await dangerous,false,'Escape cancels the operation');
 assert.equal(document.activeElement,opener,'cancellation restores the invoking control');
 assert.equal(host.hidden,true);
 assert.equal(document.listenerCount('keydown'),0,'keyboard trap is removed on close');
 assert.equal(document.listenerCount('focusin'),0,'focus guard is removed on close');

 opener.focus();
 const replaced=window.confirmAction('First');
 const replacement=window.confirmAction('Second');
 assert.equal(await replaced,false,'opening another dialog cancels the prior promise');
 assert.equal(document.listenerCount('keydown'),1,'replacement does not accumulate keyboard listeners');
 assert.equal(document.activeElement,host._dialogNodes.confirm,'ordinary confirmation focuses Continue');
 host._dialogNodes.confirm.click();
 assert.equal(await replacement,true);
 assert.equal(document.activeElement,opener);
 assert.equal(document.listenerCount('keydown'),0);

 opener.focus();opener.disabled=true;
 const deferred=window.confirmAction('Disabled opener');
 host._dialogNodes.cancel.click();
 assert.equal(await deferred,false);
 assert.notEqual(document.activeElement,opener,'a disabled invoking control is not focused during close');
 opener.disabled=false;
 assert.equal(window.SunChartsDialog.restoreFocus(),true,'the runner can restore focus after reenabling controls');
 assert.equal(document.activeElement,opener);
 assert.equal(window.SunChartsDialog.restoreFocus(),false,'a completed restoration is not retained');

 const hiddenOpener=document.body.append(document.createElement('button'));hiddenOpener.focus();
 const hiddenClose=window.confirmAction('Hidden opener');
 hiddenOpener.hidden=true;
 host._dialogNodes.cancel.click();
 assert.equal(await hiddenClose,false);
 assert.equal(window.SunChartsDialog.restoreFocus(),false,'a hidden invoking control is discarded rather than focused later');
 hiddenOpener.hidden=false;

 opener.focus();opener.disabled=true;
 const stale=window.confirmAction('Stale pending opener');
 host._dialogNodes.cancel.click();
 await stale;
 const freshOpener=document.body.append(document.createElement('button'));freshOpener.focus();
 const fresh=window.confirmAction('New dialog clears stale restoration');
 opener.disabled=false;
 assert.equal(window.SunChartsDialog.restoreFocus(),false,'opening a new dialog clears an older deferred restoration');
 host._dialogNodes.cancel.click();
 await fresh;
 assert.equal(document.activeElement,freshOpener,'the new dialog retains its own invoking control');

 const controller=new AbortController();
 opener.focus();
 const aborted=window.confirmAction('Wait for completion',{signal:controller.signal});
 controller.abort();
 assert.equal(await aborted,false,'AbortSignal cancellation resolves false');
 assert.equal(document.activeElement,opener,'aborting restores focus');
 assert.equal(document.listenerCount('keydown'),0,'aborting cleans keyboard listeners');

 const alreadyAborted=new AbortController();alreadyAborted.abort();
 assert.equal(await window.confirmAction('Never shown',{signal:alreadyAborted.signal}),false);
 assert.equal(host.hidden,true,'an already-aborted request does not open the dialog');

 const backdropCancel=window.confirmAction('Cancel from backdrop');
 host._dialogNodes.backdrop.click();
 assert.equal(await backdropCancel,false);
 assert.equal(document.activeElement,opener);

 const apiCancel=window.confirmAction('Cancelled by navigation');
 window.SunChartsDialog.close();
 assert.equal(await apiCancel,false,'programmatic close is a cancellation');
 assert.equal(document.activeElement,opener);
 assert.equal(document.listenerCount('keydown'),0);

 assert.match(index,/<script src="\/dialog\.js"><\/script>/);
 assert.match(portal,/<script src="\/dialog\.js" defer><\/script>/);
 const dialogRules=style.match(/^#suncharts-dialog-host\{[^\n]+$/m)?.[0];
 assert.ok(dialogRules?.includes('.app-dialog footer button'),'the app stylesheet contains complete scoped dialog controls');
 assert.ok(portalStyle.includes(dialogRules),'the patient portal uses the same external dialog rules');
 assert.equal(document.head.children.length,0,'opening confirmations never injects an inline stylesheet');
 for(const name of scripts){
  const script=fs.readFileSync(`web/${name}`,'utf8');
  assert.doesNotMatch(script,/\b(?:window\.)?confirm\s*\(/,`${name} must not use browser confirm dialogs`);
  assert.doesNotMatch(script,/\b(?:window\.)?alert\s*\(/,`${name} must not use browser alert dialogs`);
 }
 console.log('PASS dialog lifecycle, focus safety, cancellation and browser-dialog replacement');
})().catch(error=>{console.error(error);process.exitCode=1});
