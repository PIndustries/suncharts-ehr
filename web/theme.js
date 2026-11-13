// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Load synchronously in <head>, before stylesheets, to select the first frame.
// This preference is device-local presentation data, never account/patient data.
(()=>{
 const key='suncharts.theme.preference',preferences=['system','light','dark'];
 const root=document.documentElement;
 let preference='system',media;
 try{const saved=localStorage.getItem(key);if(preferences.includes(saved))preference=saved;}catch{/* Storage may be disabled. The current session still supports overrides. */}
 try{media=window.matchMedia('(prefers-color-scheme: dark)');}catch{/* Older webviews use light until explicitly overridden. */}
 function state(){return {preference,theme:preference==='system'?(media?.matches?'dark':'light'):preference};}
 function apply(){
  const value=state();root.dataset.theme=value.theme;root.dataset.themePreference=value.preference;root.style.colorScheme=value.theme;
  // Only the dropdowns: the page root carries the same attribute and must not get a tooltip.
  for(const select of document.querySelectorAll('select[data-theme-preference]')){select.value=value.preference;select.title=value.preference==='system'?`Follow system appearance (${value.theme})`:`${value.theme==='dark'?'Dark':'Light'} appearance`;}
  document.dispatchEvent(new CustomEvent('suncharts:theme-change',{detail:value}));
  return value;
 }
 function setPreference(value){
  if(!preferences.includes(value))return state();
  preference=value;try{localStorage.setItem(key,value);}catch{/* Keep a usable in-memory preference. */}
  return apply();
 }
 function mount(host,kind){
  if(!host||host.querySelector(`[data-theme-control="${kind}"]`))return;
  const label=document.createElement('label');label.className=`theme-control theme-control--${kind}`;label.dataset.themeControl=kind;
  const caption=document.createElement('span');caption.textContent='Appearance';label.append(caption);
  const select=document.createElement('select');select.dataset.themePreference='';select.setAttribute('aria-label','Color theme');select.id=`theme-preference-${kind}`;
  for(const value of preferences){const option=document.createElement('option');option.value=value;option.textContent=value==='system'?'System':value==='light'?'Light':'Dark';select.append(option);}
  select.value=preference;select.addEventListener('change',()=>setPreference(select.value));label.append(select);host.append(label);
 }
 function initTheme(){mount(document.querySelector('.shell-topbar-actions'),'workspace');mount(document.querySelector('.login-intro-footer'),'login');apply();}
 apply();
 const onSystemChange=()=>{if(preference==='system')apply();};
 if(media?.addEventListener)media.addEventListener('change',onSystemChange);else media?.addListener?.(onSystemChange);
 window.addEventListener('storage',event=>{if(event.key!==key&&event.key!==null)return;preference=preferences.includes(event.newValue)?event.newValue:'system';apply();});
 window.SunChartsTheme=Object.freeze({get:state,set:setPreference});window.initTheme=initTheme;
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initTheme,{once:true});else initTheme();
})();
