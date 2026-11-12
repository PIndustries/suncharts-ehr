// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Card reader ordering for the practice owner. Stripe's Connect.js draws the reader shop and the
// order list inside this page; SunCharts never sees card or shipping details. The Stripe script
// is requested only when the owner opens this page, never at sign-in or on patient screens.
// Loader, init call and element names follow
// https://docs.stripe.com/connect/get-started-connect-embedded-components (Use Connect.js without npm)
// https://docs.stripe.com/connect/supported-embedded-components/terminal-hardware-shop
// https://docs.stripe.com/connect/supported-embedded-components/terminal-hardware-orders
const cardReaderApi='/api/v1/billing/payments/readers/hardware-session';
const cardReaderScriptUrl='https://connect-js.stripe.com/v1.0/connect.js';
// Same colours as theme.css, so the Stripe views match the light and dark workspace.
const cardReaderPalettes={
 light:{colorPrimary:'#126d77',colorBackground:'#ffffff',colorText:'#233541',colorSecondaryText:'#607482',colorBorder:'#d8e1e6',colorDanger:'#a43f35',buttonPrimaryColorBackground:'#126d77',buttonPrimaryColorBorder:'#126d77',buttonPrimaryColorText:'#ffffff',buttonSecondaryColorBackground:'#f5f8fa',buttonSecondaryColorBorder:'#d8e1e6',buttonSecondaryColorText:'#233541',actionPrimaryColorText:'#126d77',formBackgroundColor:'#ffffff',offsetBackgroundColor:'#f5f8fa',formAccentColor:'#126d77',formHighlightColorBorder:'#167e91'},
 dark:{colorPrimary:'#7cd6d0',colorBackground:'#142630',colorText:'#e4edf2',colorSecondaryText:'#a6b8c5',colorBorder:'#344955',colorDanger:'#ffb9af',buttonPrimaryColorBackground:'#81d9d1',buttonPrimaryColorBorder:'#81d9d1',buttonPrimaryColorText:'#10282d',buttonSecondaryColorBackground:'#1b323e',buttonSecondaryColorBorder:'#344955',buttonSecondaryColorText:'#e4edf2',actionPrimaryColorText:'#7cd6d0',formBackgroundColor:'#142630',offsetBackgroundColor:'#10212b',formAccentColor:'#7cd6d0',formHighlightColorBorder:'#86e1da'}
};
let cardReaderGeneration=0,cardReaderLoader=null,cardReaderConnection=null;

function renderCardReadersAdminEntry(){return me?.role==='owner'?'<button type="button" data-card-readers>Card readers</button>':'';}
function cardReaderAppearance(){
 const theme=document.documentElement?.dataset?.theme==='dark'?'dark':'light';
 return {variables:{...cardReaderPalettes[theme]}};
}
function cardReaderPage(body,paymentAccount=true,opened=0){
 return `<section id="card-readers-workspace" data-card-readers-page="${opened}"><div class="section-head"><div><h2>Card readers</h2></div>${paymentAccount?'<button type="button" data-payment-settings>Payment account</button>':''}</div><p>Readers are ordered from Stripe, shipped to the practice and billed by Stripe.</p>${body}</section>`;
}
const cardReaderNotConnected='<div class="notice"><p>Finish payment setup before ordering a reader.</p><p><button type="button" class="primary" data-payment-settings>Payment setup</button></p></div>';
const cardReaderUnavailable='<div class="notice"><p>Reader ordering is not available yet.</p><p><button type="button" data-support-tickets>Support</button></p></div>';
function cardReaderFailure(message){return `<div class="notice error"><p>${esc(message)}</p><p><button type="button" data-card-readers>Try again</button></p></div>`;}
const cardReaderLoadFailure='Reader ordering could not load. Try again.';

// Stripe documents this pattern for pages without a bundler: add the script tag to <head>, and
// Connect.js calls StripeConnect.onLoad when it is ready.
function loadCardReaderScript(){
 if(typeof window.StripeConnect?.init==='function')return Promise.resolve(window.StripeConnect);
 if(cardReaderLoader)return cardReaderLoader;
 const loader=cardReaderLoader=new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  // The workspace stays busy while this loads, so a stalled download gives up after 20 seconds.
  const fail=()=>{clearTimeout(timer);if(cardReaderLoader!==loader)return;cardReaderLoader=null;script.remove?.();reject(new Error(cardReaderLoadFailure));};
  const timer=setTimeout(fail,20000);
  window.StripeConnect=window.StripeConnect||{};
  window.StripeConnect.onLoad=()=>{clearTimeout(timer);resolve(window.StripeConnect);};
  script.src=cardReaderScriptUrl;script.async=true;script.onerror=fail;
  document.head.appendChild(script);
 });
 return cardReaderLoader;
}
// One Stripe instance per signed-in owner, as Stripe recommends. Stripe calls fetchClientSecret
// again by itself when a long visit outlasts the first secret.
function cardReaderConnect(stripe,data,identity){
 const existing=cardReaderConnection;
 if(existing&&existing.identity===identity&&existing.key===data.publishable_key){
  existing.instance.update({appearance:cardReaderAppearance()});
  return existing;
 }
 endCardReaderConnection();
 const connection={identity,key:data.publishable_key,first:data.client_secret,instance:null};
 connection.instance=stripe.init({
  publishableKey:data.publishable_key,
  fetchClientSecret:async()=>{
   if(connection.first){const secret=connection.first;connection.first=null;return secret;}
   if(me!==connection.identity||cardReaderConnection!==connection)throw new Error('Sign in again to continue.');
   const next=await api(cardReaderApi,'POST',{});
   if(next.status!=='ready'||next.publishable_key!==connection.key||me!==connection.identity)throw new Error(cardReaderLoadFailure);
   return next.client_secret;
  },
  appearance:cardReaderAppearance()
 });
 cardReaderConnection=connection;
 return connection;
}
function mountCardReaders(connection,current){
 const shopHost=$('card-reader-shop'),ordersHost=$('card-reader-orders');
 const shop=connection.instance.create('terminal-hardware-shop');
 const orders=()=>{
  const list=connection.instance.create('terminal-hardware-orders');
  list.setOnLoadError?.(failed);
  return list;
 };
 // Stripe may report the same load failure more than once; showing the message is repeatable.
 function failed(event){if(!current())return;const host=$('card-reader-status');if(!host)return;const detail=String(event?.error?.message||'').trim().slice(0,300);host.innerHTML=cardReaderFailure(cardReaderLoadFailure)+(detail?`<p class="muted">Stripe said: ${esc(detail)}</p>`:'');if(detail&&typeof console!=='undefined')console.warn('Card reader ordering:',event?.error?.type||'',detail);}
 shop.setOnLoadError?.(failed);
 // A finished checkout adds an order, so the list below is drawn again.
 shop.setOnCheckoutFinished?.(()=>{if(current()&&$('card-reader-orders')===ordersHost)ordersHost.replaceChildren(orders());});
 shopHost.appendChild(shop);
 ordersHost.appendChild(orders());
}
async function openCardReaders(){
 if(me?.role!=='owner')throw new Error('Only the practice owner can order card readers.');
 const generation=++cardReaderGeneration,identity=me,host=$('tools');showTool('Card readers');
 // Each opening marks its own page, so a slow answer never draws over a newer screen. The
 // marker is checked instead of the whole page text because Stripe's views change the page.
 const page=(body,paymentAccount)=>cardReaderPage(body,paymentAccount,generation);
 const current=()=>generation===cardReaderGeneration&&me===identity&&$('tools')===host&&!host.hidden&&host.innerHTML.includes(`data-card-readers-page="${generation}"`);
 const show=html=>{if(current())host.innerHTML=html;};
 host.innerHTML=page('<p role="status">Loading card readers…</p>');
 let data;
 try{data=await api(cardReaderApi,'POST',{});}
 catch(error){
  if(error.status===403||!me)throw error;
  show(page(cardReaderFailure(error.status?error.message:'Reader ordering could not be opened. Check your connection and try again.')));return;
 }
 if(!current())return;
 if(data.status==='not_connected'){show(page(cardReaderNotConnected,false));return;}
 if(data.status!=='ready'||typeof data.client_secret!=='string'||typeof data.publishable_key!=='string'){show(page(cardReaderUnavailable));return;}
 let stripe;
 try{stripe=await loadCardReaderScript();}
 catch(error){show(page(cardReaderFailure(error.message)));return;}
 if(!current())return;
 show(page('<div id="card-reader-status"></div><section class="billing-section"><h3>Order a reader</h3><div id="card-reader-shop"></div></section><section class="billing-section"><h3>Your orders</h3><div id="card-reader-orders"></div></section>'));
 try{mountCardReaders(cardReaderConnect(stripe,data,identity),current);}
 catch{endCardReaderConnection();show(page(cardReaderFailure(cardReaderLoadFailure)));}
}
function endCardReaderConnection(){
 const connection=cardReaderConnection;cardReaderConnection=null;
 try{Promise.resolve(connection?.instance?.logout()).catch(()=>{});}catch{/* Signing out continues even if Stripe is unreachable. */}
}
// Called when the staff member signs out, so the next person on this computer starts clean.
function clearCardReadersSession(){cardReaderGeneration++;endCardReaderConnection();}
document.addEventListener('suncharts:theme-change',()=>{
 try{cardReaderConnection?.instance.update({appearance:cardReaderAppearance()});}catch{/* The theme still changes for the rest of the workspace. */}
});
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button[data-card-readers]');if(!button)return;
 event.preventDefault();run(openCardReaders);
});
