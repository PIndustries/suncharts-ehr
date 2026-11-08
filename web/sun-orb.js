// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// A persistent, local workspace presence. Model output never controls the DOM.
let sunPanelView='chat',sunOrbObserver=null,sunOrbPosition={x:1,y:1},sunOrbDrag=null,sunOrbSuppressClick=false,sunOrbNavigation=null,sunOrbNavigationTimer=null,sunOrbWorkspace=null;
const sunOrbPositionKey='suncharts.sun.position.v1';
function sunOrbClamp(value){return Number.isFinite(value)?Math.max(0,Math.min(1,value)):1;}
function placeSunOrb(){
 const orb=$('sun-presence');if(!orb)return;
 const viewport=window.visualViewport,width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight;
 const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0;
 orb.style.left=`${left+12+sunOrbPosition.x*Math.max(0,width-orb.offsetWidth-24)}px`;
 orb.style.top=`${top+12+sunOrbPosition.y*Math.max(0,height-orb.offsetHeight-24)}px`;
 placeSunChat();
}
function placeSunChat(){
 const panel=$('sun-panel'),orb=$('sun-presence');if(!panel||panel.hidden||sunPanelView!=='chat'||!orb)return;
 const viewport=window.visualViewport,width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0;
 const panelWidth=Math.min(460,Math.max(0,width-24)),panelHeight=Math.min(640,Math.max(0,height-24)),orbLeft=parseFloat(orb.style.left)||left+12,orbTop=parseFloat(orb.style.top)||top+12;
 const preferredLeft=orbLeft-left>width/2?orbLeft-panelWidth-14:orbLeft+orb.offsetWidth+14;
 panel.style.width=`${panelWidth}px`;panel.style.height=`${panelHeight}px`;
 panel.style.left=`${Math.max(left+12,Math.min(preferredLeft,left+width-panelWidth-12))}px`;
 panel.style.top=`${Math.max(top+12,Math.min(orbTop+orb.offsetHeight-panelHeight,top+height-panelHeight-12))}px`;
}
function saveSunOrbPosition(){try{localStorage.setItem(sunOrbPositionKey,JSON.stringify(sunOrbPosition));}catch{/* Position is optional; no clinical data is stored. */}}
function clearSunOrb(){
 sunOrbObserver?.disconnect();sunOrbObserver=null;clearTimeout(sunOrbNavigationTimer);sunOrbNavigation=null;sunOrbDrag=null;sunOrbWorkspace=null;sunPanelView='chat';
 $('sun-presence')?.remove();$('sun-workspace-guide')?.remove();document.querySelectorAll('.sun-guided-target').forEach(node=>node.classList.remove('sun-guided-target'));
}
function mountSunWorkspace(){
 const panel=$('sun-panel');if(!panel)return;
 const page=sunPanelView==='page',host=page?$('sun-page-root'):document.body;if(!host)return;
 if(panel.dataset.sunView&&panel.dataset.sunView!==sunPanelView&&typeof sunPrivacyReview!=='undefined'&&sunPrivacyReview){sunInvalidatePrivacyReview();sunStatus('The workspace context changed. Ask Sun again to prepare a new outgoing preview.');}
 panel.dataset.sunView=sunPanelView;
 if(panel.parentElement!==host)host.append(panel);
 panel.classList.remove('sun-inline-workspace',page?'sun-floating-chat':'sun-page-workspace');panel.classList.add(page?'sun-page-workspace':'sun-floating-chat');
 panel.setAttribute('aria-label',page?'Sun assistant':'Sun chat');$('sun-close').setAttribute('aria-label','Collapse Sun to orb');
 if(!$('sun-settings')){
  const header=panel.querySelector('header'),actions=document.createElement('div');actions.className='sun-panel-actions';
  const expand=document.createElement('button');expand.id='sun-expand-page';expand.type='button';actions.append(expand,$('sun-close'));header?.append(actions);
  const settings=document.createElement('details');settings.id='sun-settings';const summary=document.createElement('summary');summary.textContent='Settings & capabilities';settings.append(summary);
  const settingsBody=document.createElement('div');settingsBody.className='sun-settings-body';settings.append(settingsBody);
  for(const node of [$('sun-mode')?.parentElement,$('sun-provider-label'),$('sun-context'),$('sun-voice-note'),$('sun-install-voice'),$('sun-speak')?.parentElement,$('sun-privacy-guide'),$('sun-review'),$('sun-workflows')])if(node)settingsBody.append(node);
  const conversation=document.createElement('div');conversation.id='sun-conversation';conversation.setAttribute('role','region');conversation.setAttribute('aria-label','Sun responses');
  for(const node of [panel.querySelector('.sun-intro'),$('sun-status'),$('sun-answer'),$('sun-privacy-preview')])if(node)conversation.append(node);
  const composer=document.createElement('div');composer.id='sun-composer';
  for(const node of [$('sun-text')?.parentElement,$('sun-examples'),$('sun-patient-context-area'),$('sun-interim'),panel.querySelector('.sun-controls')])if(node)composer.append(node);
  panel.append(settings,conversation,composer);
 }
 const expand=$('sun-expand-page');if(expand){expand.textContent=page?'Floating chat':'Open Sun page';expand.setAttribute('aria-label',page?'Return to floating chat':'Open Sun page');expand.onclick=()=>{if(sunPanelView==='page'){if(typeof returnSunToChat==='function')returnSunToChat();}else if(typeof showSunPage==='function')void showSunPage();};}
 if(page)for(const key of ['left','top','width','height'])panel.style[key]='';
 const guide=$('sun-privacy-guide');if(guide&&!guide.querySelector('details')){
  const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='How Sun handles privacy and approval';details.append(summary);
  while(guide.firstChild)details.append(guide.firstChild);guide.append(details);
 }
 sunOrbObserver?.observe(panel,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden','aria-pressed']});
 updateSunOrb();placeSunChat();
}
function collapseSunWorkspace(){if(sunPanelView==='page'&&typeof returnSunToChat==='function'&&returnSunToChat()===false)return false;if($('sun-panel'))$('sun-panel').hidden=true;updateSunOrb();$('sun-open')?.focus();return true;}
function updateSunOrb(){
 const orb=$('sun-presence');if(!orb||!me)return;
 const expanded=!!$('sun-panel')&&!$('sun-panel').hidden;
 const listening=typeof sunListening!=='undefined'&&sunListening;
 const running=typeof sunBusy!=='undefined'&&sunBusy;
 const review=typeof sunPrivacyReview!=='undefined'&&!!sunPrivacyReview;
 const speaking=!!window.speechSynthesis?.speaking;
 const answer=!!$('sun-answer')&&!$('sun-answer').hidden;
 const state=listening?'listening':speaking?'speaking':running?'working':review?'approval':answer?'ready':'idle';
 const labels={idle:'Sun',listening:'Listening',speaking:'Speaking',working:'Working',approval:'Review needed',ready:$('sun-answer')?.dataset.origin==='local'?'Answer ready':'Draft ready'};
 if(orb.dataset.state!==state)orb.dataset.state=state;
 const label=$('sun-orb-label');if(label.textContent!==labels[state])label.textContent=labels[state];
 $('sun-open').setAttribute('aria-expanded',String(expanded));$('sun-open').setAttribute('aria-label',`${expanded?'Collapse':'Open'} Sun chat · ${labels[state]}`);
 const stop=$('sun-orb-stop');stop.hidden=!listening&&!speaking;stop.textContent=listening?'Stop microphone':'Stop speaking';
 const workspace=$('page-title')?.textContent||'this workspace';
 if(sunOrbWorkspace&&sunOrbWorkspace!==workspace&&!sunOrbNavigation){const status=$('sun-status');if(status&&/ is open\. You can continue here\.$/.test(status.textContent))status.textContent='Ready in this workspace.';}
 sunOrbWorkspace=workspace;const context=$('sun-guide-context');
 if(context&&context.textContent!==workspace)context.textContent=workspace;
 const status=$('sun-status')?.textContent||'Ready when you are. Open Sun to navigate, dictate or prepare a draft.';
 const progress=$('sun-guide-progress');if(progress&&progress.textContent!==status)progress.textContent=status;
 placeSunOrb();
}
function finishSunNavigation(){
 if(!sunOrbNavigation||!me)return;
 const target=$(sunOrbNavigation),loading=$('shell-loading');
 if(target?.getAttribute('aria-current')!=='page'||(loading&&!loading.hidden))return;
 const notice=$('notice');if(notice&&!notice.hidden&&notice.classList.contains('error')){sunOrbNavigation=null;clearTimeout(sunOrbNavigationTimer);sunStatus('The workspace could not finish loading. Review the page error before continuing.');return;}
 sunOrbNavigation=null;clearTimeout(sunOrbNavigationTimer);
 const heading=$('page-title');heading?.classList.add('sun-guided-target');
 const text=heading?.textContent||'Requested workspace';sunStatus(`${text} is open. You can continue here.`);
 setTimeout(()=>heading?.classList.remove('sun-guided-target'),3500);
}
function initSunOrb(){
 if(!me||me.role==='patient'||$('sun-presence'))return;
 try{const value=JSON.parse(localStorage.getItem(sunOrbPositionKey));if(value&&typeof value==='object')sunOrbPosition={x:sunOrbClamp(value.x),y:sunOrbClamp(value.y)};}catch{/* Default to bottom right. */}
 const orb=document.createElement('div');orb.id='sun-presence';orb.dataset.state='idle';
 orb.innerHTML='<button id="sun-open" type="button" class="sun-orb" aria-label="Open Sun chat" aria-controls="sun-panel" aria-expanded="false" aria-describedby="sun-orb-help"><span class="sun-orb-light" aria-hidden="true"></span><span class="sun-orb-center" aria-hidden="true">✳</span></button><span id="sun-orb-label" class="sun-orb-label" aria-live="polite">Sun</span><button type="button" id="sun-orb-stop" hidden>Stop microphone</button><span id="sun-orb-help" class="sr-only">Drag to move Sun, or use arrow keys while focused. Home resets the position. Enter opens a floating Sun chat.</span>';
 document.body.append(orb);
 const guide=document.createElement('section');guide.id='sun-workspace-guide';guide.setAttribute('aria-label','Sun workspace activity');guide.hidden=true;
 guide.innerHTML='<span class="sun-guide-mark" aria-hidden="true">✳</span><div><strong>Sun <span aria-hidden="true">·</span> <span id="sun-guide-context"></span></strong><p id="sun-guide-progress" role="status"></p></div><button id="sun-guide-open" type="button">Open Sun</button><button id="sun-guide-dismiss" type="button" aria-label="Dismiss Sun activity">✕</button>';
 document.body.append(guide);
 $('sun-guide-open').onclick=()=>void openSun();$('sun-guide-dismiss').onclick=()=>{guide.hidden=true;};
 $('sun-open').onclick=event=>{if(sunOrbSuppressClick&&event.detail!==0){sunOrbSuppressClick=false;return;}if($('sun-panel')&&!$('sun-panel').hidden)$('sun-close').click();else void openSun();};
 $('sun-orb-stop').onclick=()=>{stopSunListening();window.speechSynthesis?.cancel();sunStatus('Voice stopped.');updateSunOrb();};
 const button=$('sun-open');
 button.onpointerdown=event=>{if(event.button!==0)return;sunOrbDrag={id:event.pointerId,x:event.clientX,y:event.clientY,position:{...sunOrbPosition},moved:false};button.setPointerCapture(event.pointerId);sunOrbSuppressClick=false;};
 button.onpointermove=event=>{const drag=sunOrbDrag;if(!drag||drag.id!==event.pointerId)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<6)return;drag.moved=true;sunOrbSuppressClick=true;const viewport=window.visualViewport;sunOrbPosition={x:sunOrbClamp(drag.position.x+dx/Math.max(1,(viewport?.width||window.innerWidth)-orb.offsetWidth-24)),y:sunOrbClamp(drag.position.y+dy/Math.max(1,(viewport?.height||window.innerHeight)-orb.offsetHeight-24))};placeSunOrb();};
 const endDrag=()=>{if(sunOrbDrag?.moved)saveSunOrbPosition();sunOrbDrag=null;};button.onpointerup=endDrag;button.onpointercancel=()=>{sunOrbSuppressClick=false;endDrag();};button.onlostpointercapture=endDrag;
 button.onkeydown=event=>{const steps={ArrowLeft:[-.05,0],ArrowRight:[.05,0],ArrowUp:[0,-.05],ArrowDown:[0,.05]};if(event.key==='Home'){event.preventDefault();sunOrbPosition={x:1,y:1};}else if(steps[event.key]){event.preventDefault();sunOrbPosition={x:sunOrbClamp(sunOrbPosition.x+steps[event.key][0]),y:sunOrbClamp(sunOrbPosition.y+steps[event.key][1])};}else return;saveSunOrbPosition();placeSunOrb();};
 sunOrbObserver=new MutationObserver(()=>{updateSunOrb();finishSunNavigation();});
 for(const id of ['page-title','shell-loading','notice'])if($(id))sunOrbObserver.observe($(id),{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['hidden','class']});
 updateSunOrb();
}
document.addEventListener('suncharts:sun-navigation',event=>{
 const target=event.detail?.target;if(!me||typeof target!=='string'||!Object.values(sunNavigation).includes(target))return;
 $('sun-workspace-guide').hidden=false;sunOrbNavigation=target;clearTimeout(sunOrbNavigationTimer);
 sunOrbNavigationTimer=setTimeout(()=>{if(sunOrbNavigation){sunOrbNavigation=null;sunStatus('The requested workspace has not finished opening. Check the page status.');}},15000);
 queueMicrotask(finishSunNavigation);
});
window.addEventListener('resize',placeSunOrb);window.visualViewport?.addEventListener('resize',placeSunOrb);window.visualViewport?.addEventListener('scroll',placeSunOrb);
