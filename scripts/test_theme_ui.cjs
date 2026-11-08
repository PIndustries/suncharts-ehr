// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const script=fs.readFileSync('web/theme.js','utf8'),css=fs.readFileSync('web/theme.css','utf8');
const key='suncharts.theme.preference';
function fixture({saved=null,dark=false,storageDenied=false,mediaUnavailable=false}={}){
 const listeners={},windowListeners={},writes=[],nodes=[],events=[];let systemChange;
 function node(tag='div'){
  const value={tag,dataset:{},style:{},children:[],listeners:{},append(child){this.children.push(child);},setAttribute(name,v){this[name]=v;},addEventListener(name,fn){this.listeners[name]=fn;},querySelector(selector){const kind=selector.match(/data-theme-control="([^"]+)"/)?.[1];return this.children.find(child=>child.dataset.themeControl===kind)||null;}};nodes.push(value);return value;
 }
 const root=node('html'),topbar=node(),footer=node();
 const media={matches:dark,addEventListener(name,fn){assert.equal(name,'change');systemChange=fn;}};
 const document={documentElement:root,readyState:'loading',querySelector:selector=>selector==='.shell-topbar-actions'?topbar:selector==='.login-intro-footer'?footer:null,querySelectorAll:()=>nodes.filter(n=>Object.hasOwn(n.dataset,'themePreference')),createElement:node,addEventListener:(name,fn)=>listeners[name]=fn,dispatchEvent:event=>events.push(event)};
 const c={document,CustomEvent:class{constructor(type,{detail}){this.type=type;this.detail=detail;}},localStorage:{getItem(){if(storageDenied)throw new Error('denied');return saved;},setItem(k,value){if(storageDenied)throw new Error('denied');writes.push([k,value]);}},window:{matchMedia:query=>{assert.equal(query,'(prefers-color-scheme: dark)');if(mediaUnavailable)throw new Error('unsupported');return media;},addEventListener:(name,fn)=>windowListeners[name]=fn}};
 vm.createContext(c);vm.runInContext(script,c);
 return {c,root,topbar,footer,writes,events,ready:()=>listeners.DOMContentLoaded(),changeSystem:value=>{media.matches=value;systemChange?.();},storage:value=>windowListeners.storage({key,newValue:value}),set:value=>c.window.SunChartsTheme.set(value),get:()=>c.window.SunChartsTheme.get()};
}
let f=fixture({dark:true});assert.equal(f.root.dataset.theme,'dark','system theme applied synchronously before DOM ready');assert.equal(f.root.style.colorScheme,'dark');assert.equal(f.topbar.children.length,0);f.ready();assert.equal(f.topbar.children.length,1);assert.equal(f.footer.children.length,1);f.c.window.initTheme();assert.equal(f.topbar.children.length,1,'mount is idempotent');
const select=f.topbar.children[0].children[1];assert.equal(select['aria-label'],'Color theme');assert.deepEqual(select.children.map(option=>option.textContent),['System','Light','Dark']);assert.equal(select.value,'system');
f.changeSystem(false);assert.equal(f.root.dataset.theme,'light','automatic mode follows OS changes');select.value='dark';select.listeners.change();assert.equal(f.get().preference,'dark');assert.equal(f.root.dataset.theme,'dark');f.changeSystem(false);assert.equal(f.root.dataset.theme,'dark','explicit preference overrides OS');assert.deepEqual(f.writes,[[key,'dark']]);assert.equal(f.footer.children[0].children[1].value,'dark','selectors stay synchronized');
f.storage('light');assert.equal(f.root.dataset.theme,'light','other tabs synchronize preference');f.storage(null);assert.equal(f.get().preference,'system');f.changeSystem(true);assert.equal(f.root.dataset.theme,'dark');assert.equal(f.set('unexpected').preference,'system','invalid preference ignored');
f=fixture({saved:'dark',dark:false});assert.equal(f.root.dataset.theme,'dark','saved override applied before first paint');
f=fixture({saved:'invalid',dark:false});assert.equal(f.get().preference,'system');assert.equal(f.root.dataset.theme,'light');
f=fixture({dark:true,storageDenied:true});f.ready();f.set('light');assert.equal(f.root.dataset.theme,'light','storage denial does not disable in-memory choice');
f=fixture({mediaUnavailable:true});assert.equal(f.root.dataset.theme,'light');f.set('dark');assert.equal(f.root.dataset.theme,'dark');
// Check the authored palette's normal-text pairs, not a filter inversion.
function luminance(hex){const rgb=hex.replace('#','').match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];}
function ratio(a,b){const values=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (values[0]+.05)/(values[1]+.05);}
for(const [label,fg,bg] of [['dark body','#e4edf2','#142630'],['dark muted','#a6b8c5','#142630'],['dark action','#10282d','#81d9d1'],['dark success','#a1e1b6','#15392c'],['dark warning','#efd08a','#3b301b'],['dark error','#ffb9af','#432a2c'],['dark approval','#d2b8ef','#342d4b'],['dark login','#b2cabc','#13281f'],['light hero','#203d31','#eaf3ed'],['light hero secondary','#526e5e','#eaf3ed']])assert.ok(ratio(fg,bg)>=4.5,`${label} must reach 4.5:1 text contrast`);
assert.doesNotMatch(css,/filter\s*:\s*invert/i,'images and clinical documents must not be inverted');
console.log('PASS theme UI: first-paint system/preference resolution, automatic OS changes, explicit overrides, storage synchronization/fallback, accessible idempotent selectors, and palette contrast');
