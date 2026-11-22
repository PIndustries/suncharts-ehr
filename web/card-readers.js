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
 return `<section id="card-readers-workspace" data-card-readers-page="${opened}"><div class="section-head"><div><h2>Card readers</h2></div>${paymentAccount?'<button type="button" data-payment-settings>Payment account</button>':''}</div><div id="card-reader-list">${cardReaderListMarkup()}</div><p>Readers are ordered from Stripe, shipped to the practice and billed by Stripe.</p>${body}</section>`;
}
const cardReaderNotConnected='<div class="notice"><p>Finish payment setup before ordering a reader.</p><p><button type="button" class="primary" data-payment-settings>Payment setup</button></p></div>';
const cardReaderUnavailable='<div class="notice"><p>Reader ordering is not available yet.</p><p><button type="button" data-support-tickets>Support</button></p></div>';
function cardReaderFailure(message){return `<div class="notice error"><p>${esc(message)}</p><p><button type="button" data-card-readers>Try again</button></p></div>`;}
const cardReaderLoadFailure='Reader ordering could not load. Try again.';
// Stripe's ordering page never arrived in this browser. The line the owner reads names what the
// browser actually reported, so a slow connection is never blamed on an ad blocker.
const cardReaderRetryHint='If this keeps happening, turn off any ad or tracker blocker for this site, or try another browser or network.';
// The page policy can report a blocked address while the page is still being drawn, so the name is
// kept for the next message shown rather than thrown at a half-built screen.
let cardReaderViolation='';
function cardReaderFailureMessage(reason){
 switch(reason?.kind){
  case 'blocked':return `Reader ordering could not load. The browser blocked ${cardReaderViolation||'stripe.com'}. ${cardReaderRetryHint}`;
  case 'timeout':return 'Reader ordering could not load. The connection to Stripe timed out. Check your connection and try again.';
  case 'unreachable':return `Reader ordering could not load. The browser could not reach stripe.com. ${cardReaderRetryHint}`;
  // Connect.js arrived but its views could not be started: the browser refused to run it.
  case 'refused':return `Reader ordering could not start in this browser. ${cardReaderRetryHint}`;
  default:return cardReaderLoadFailure;
 }
}
function cardReaderHost(uri){
 const match=/^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(String(uri||''));
 return match?match[1].toLowerCase():'';
}
function noteCardReaderViolation(event){
 const uri=String(event?.blockedURI||'');
 if(!/stripe/i.test(uri)&&!/stripe/i.test(String(event?.violatedDirective||'')))return;
 cardReaderViolation=cardReaderHost(uri)||'stripe.com';
}
// A page policy report is read even on a screen that never asks for the script, so the listener is
// only attached where the browser offers one.
const cardReaderPolicyHost=typeof globalThis.window?.addEventListener==='function'?globalThis.window:null;
if(cardReaderPolicyHost)cardReaderPolicyHost.addEventListener('securitypolicyviolation',event=>noteCardReaderViolation(event));

// Stripe documents this pattern for pages without a bundler: add the script tag to <head>, and
// Connect.js calls StripeConnect.onLoad when it is ready. The script's own load event is watched as
// well, and readiness always means StripeConnect.init is a function: a download that finished while
// init exists is ready even if that callback never fires, which is what made a healthy connection
// read as a blocked browser. A tag that neither loaded nor failed is retried once before any
// message, and the wait ends at 30 seconds however it ends.
const cardReaderLoadTimeout=30000,cardReaderRetryDelay=1000;
function loadCardReaderScript(){
 if(typeof window.StripeConnect?.init==='function')return Promise.resolve(window.StripeConnect);
 if(cardReaderLoader)return cardReaderLoader;
 let settle;
 const loader=cardReaderLoader=new Promise((resolve,reject)=>{settle={resolve,reject};});
 let deadline=null,wait=null,tag=null,cause=null,attempt=0,reported=null;
 const live=()=>typeof window.StripeConnect?.init==='function';
 const stop=()=>{clearTimeout(deadline);clearTimeout(wait);deadline=wait=null;if(reported){window.removeEventListener?.('securitypolicyviolation',reported);reported=null;}};
 const drop=()=>{tag?.remove?.();tag=null;};
 // What the browser reported, in the owner's words. An address the page policy refused outranks
 // everything else, because it also explains a script tag that simply never arrives.
 const reason=()=>cardReaderViolation?{kind:'blocked'}:{kind:cause||'unreachable'};
 const finish=()=>{stop();if(cardReaderLoader!==loader)return;cardReaderLoader=null;drop();settle.reject(new Error(cardReaderFailureMessage(reason())));};
 // The load event and the documented callback both end the wait here, at once. A script that
 // arrived without StripeConnect.init is only usable if the browser did not also refuse it.
 const announce=()=>{
  if(cardReaderLoader!==loader)return;
  if(cardReaderViolation||(!live()&&cause))return finish();
  stop();cardReaderLoader=null;drop();settle.resolve(window.StripeConnect);
 };
 // One automatic retry with a fresh tag: a single refused request is often only a hiccup. The
 // reason is kept through it, so a second refusal is the end and is described by what happened.
 const retry=kind=>{
  cause=kind;drop();
  wait=setTimeout(()=>{wait=null;load();},cardReaderRetryDelay);
 };
 const load=()=>{
  // The policy can refuse the address before the browser even reports anything, so a report is
  // looked for whenever the loader is about to ask for the script again.
  if(cardReaderViolation)return finish();
  if(cardReaderLoader!==loader)return;
  const script=document.createElement('script');
  script.src=cardReaderScriptUrl;script.async=true;tag=script;
  script.onerror=()=>{
   script.remove?.();
   if(cardReaderLoader!==loader)return;
   if(cardReaderViolation)return finish();
   if(attempt>=1)return finish();
   attempt+=1;retry(cause||'unreachable');
  };
  script.onload=announce;
  window.StripeConnect=window.StripeConnect||{};
  const earlier=window.StripeConnect.onLoad;
  // Connect.js calls onLoad with init in place; a callback left by an earlier visit is kept too.
  window.StripeConnect.onLoad=announce;
  // A page policy usually refuses the address without ever failing the tag, so the report itself
  // ends the wait. The page keeps its own listener for reports that arrive later.
  if(!reported&&typeof window.addEventListener==='function')window.addEventListener('securitypolicyviolation',reported=()=>{if(cardReaderViolation)finish();});
  document.head.appendChild(script);
  // The workspace stays busy while this loads, so a stalled download gives up after 30 seconds.
  if(!deadline)deadline=setTimeout(()=>{cause='timeout';finish();},cardReaderLoadTimeout);
 };
 load();
 return loader;
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
 function failed(event){if(!current())return;const host=$('card-reader-status');if(!host)return;const detail=String(event?.error?.message||'').trim().slice(0,300);host.innerHTML=cardReaderFailure(cardReaderLoadFailure)+(detail?`<p class="muted">Stripe said: ${esc(detail)}</p>`:'<p class="muted">Stripe gave no reason. If this keeps happening, turn off any ad or tracker blocker for this site or try another browser.</p>');if(detail&&typeof console!=='undefined')console.warn('Card reader ordering:',event?.error?.type||'',detail);}
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
 cardReaderListState=null;
 host.innerHTML=page('<p role="status">Loading card readers…</p>');
 // The practice's readers load alongside reader ordering; neither waits for the other.
 loadCardReaderList(current);
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
 show(page('<div id="card-reader-status"></div><section class="billing-section"><h3>Order a reader</h3><p class="muted">Readers that work with SunCharts: BBPOS WisePOS E, Stripe Reader S700, S710 and T600. The Stripe Reader M2 does not.</p><div id="card-reader-shop"></div></section><section class="billing-section"><h3>Your orders</h3><div id="card-reader-orders"></div></section>'));
 try{mountCardReaders(cardReaderConnect(stripe,data,identity),current);}
 catch{
  endCardReaderConnection();
  // The Stripe views never arrived even though Connect.js did: the browser refused to run it.
  // A policy report names the address, and an unusable script says the page cannot start ordering.
   show(page(cardReaderFailure(cardReaderFailureMessage(cardReaderViolation?{kind:'blocked'}:{kind:'refused'}))));
 }
}
function endCardReaderConnection(){
 const connection=cardReaderConnection;cardReaderConnection=null;
 try{Promise.resolve(connection?.instance?.logout()).catch(()=>{});}catch{/* Signing out continues even if Stripe is unreachable. */}
}
// Called when the staff member signs out, so the next person on this computer starts clean.
function clearCardReadersSession(){cardReaderGeneration++;endCardReaderConnection();cardReaderListState=null;stopReaderPayment();}
document.addEventListener('suncharts:theme-change',()=>{
 try{cardReaderConnection?.instance.update({appearance:cardReaderAppearance()});}catch{/* The theme still changes for the rest of the workspace. */}
});
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button[data-card-readers]');if(!button)return;
 event.preventDefault();run(openCardReaders);
});

// ---- Your readers ----------------------------------------------------------------------------
// The readers the practice has added. The owner adds a reader by typing the code the reader
// shows; every reader belongs to the practice's own Stripe account.
const cardReaderListApi='/api/v1/billing/payments/readers';
let cardReaderListState=null,cardReaderAddressForm=null;
function cardReaderRowMarkup(reader,manage){
 return `<div class="timeline-row"><div><b>${esc(reader.name)}</b><small>${esc(reader.model)} · ${reader.online?'Online':'Offline'}</small></div>${manage?`<div class="actions"><button type="button" data-rename-reader="${esc(reader.id)}">Rename</button><button type="button" data-remove-reader="${esc(reader.id)}">Remove</button></div>`:''}</div>`;
}
function cardReaderListMarkup(){
 const state=cardReaderListState;
 if(state?.failed)return '<section class="billing-section"><h3>Your readers</h3><p class="muted">Your readers could not be loaded.</p><p><button type="button" data-card-readers>Try again</button></p></section>';
 const data=state?.data;if(!data||data.status!=='ready')return '';
 const readers=data.readers||[];
 return `<section class="billing-section"><h3>Your readers</h3>${readers.map(reader=>cardReaderRowMarkup(reader,data.can_manage)).join('')||'<p class="muted">No readers added yet.</p>'}${data.can_manage&&!state.form?'<p><button type="button" data-add-reader>Add a reader</button></p>':''}${state.form||''}</section>`;
}
function paintCardReaderList(){const host=$('card-reader-list');if(host)host.innerHTML=cardReaderListMarkup();}
async function loadCardReaderList(current=()=>true){
 // Opening another screen while this one waits must not leave the address prompt on screen.
 const identity=me;
 const state=cardReaderListState={data:null,failed:false,form:''};
 try{state.data=await api(cardReaderListApi);}catch{state.failed=true;}
 if(cardReaderListState===state&&current())paintCardReaderList();
 if(cardReaderAddressForm&&(me!==identity||cardReaderListState!==state))closeCardReaderAddressForm();
 return state.data;
}
// The preview build is marked in the sidebar by the server; production never carries the mark.
function cardReaderPreviewBuild(){
 try{return /^Development preview/.test(document.querySelector?.('.sidebar-source .preview')?.textContent||'');}catch{return false;}
}
// Test payments are labelled on a preview build only; a production build shows no label.
function testPaymentLabel(){return cardReaderPreviewBuild()?'Test payment':'';}
function cardReaderAddFormMarkup(data){
 const practice=typeof data.practice_code==='string'&&cardReaderPreviewBuild()?`<p class="muted">No reader yet? Type ${esc(data.practice_code)} to add a practice reader.</p>`:'';
 return `<form id="card-reader-add-form"><h4>Add a reader</h4><label>Code on the reader<input name="code" required maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label>Reader name<input name="name" required maxlength="60" autocomplete="off" placeholder="Front desk"></label><p class="muted">On the reader, open Settings and choose Generate pairing code.</p>${practice}<button type="submit" class="primary">Add reader</button><button type="button" data-close-reader-form>Cancel</button></form>`;
}
function cardReaderById(id){return cardReaderListState?.data?.readers?.find(reader=>reader.id===id);}
function openCardReaderForm(kind,id){
 const state=cardReaderListState,data=state?.data;if(!data?.can_manage)return;
 const reader=id?cardReaderById(id):null;
 if(kind==='add')state.form=cardReaderAddFormMarkup(data);
 else if(kind==='rename'&&reader)state.form=`<form id="card-reader-rename-form" data-reader="${esc(reader.id)}"><h4>Rename reader</h4><label>Reader name<input name="name" required maxlength="60" autocomplete="off" value="${esc(reader.name)}"></label><button type="submit" class="primary">Save name</button><button type="button" data-close-reader-form>Cancel</button></form>`;
 else if(kind==='remove'&&reader)state.form=`<div class="notice"><p>Remove ${esc(reader.name)}? You can add it again later with a new code.</p><p><button type="button" class="primary" data-confirm-remove-reader="${esc(reader.id)}">Remove reader</button><button type="button" data-close-reader-form>Keep reader</button></p></div>`;
 else state.form='';
 paintCardReaderList();
}
// A retry of the same code and name reuses its request, so a reader is never added twice.
let cardReaderAddRequest=null;
async function submitCardReaderForm(form){
 const state=cardReaderListState,values=Object.fromEntries(new FormData(form)),name=String(values.name||'').trim();
 if(!state?.data?.can_manage||!name)return;
 if(form.id==='card-reader-add-form'){
  const code=String(values.code||'').trim(),content=code+'\n'+name;
  if(!code)return;
  if(cardReaderAddRequest?.content!==content)cardReaderAddRequest={content,id:crypto.randomUUID()};
  try{
   await api(cardReaderListApi,'POST',{request_id:cardReaderAddRequest.id,code,name});
   cardReaderAddRequest=null;
  }catch(error){
   // The payments service has no address for the practice. Ask for one right here, then try again.
   if(error?.status!==409||error?.code!=='practice_address_missing')throw error;
   openCardReaderAddressForm('We need the practice address before the reader can be added.',code,name);
   return;
  }
 }else await api(`${cardReaderListApi}/${encodeURIComponent(form.dataset.reader)}`,'PUT',{name});
 if(cardReaderListState!==state)return;
 await loadCardReaderList();
 notice(form.id==='card-reader-add-form'?'Reader added.':'Reader renamed.');
}
// Where the practice address can be kept, for a practice that would rather fill it in once.
const cardReaderAdminHint='You can also save this address under Practice administration, Facilities, so you are not asked again.';
// The practice address prompt. The reader is added by the same request, with a fresh request
// identifier, once the address is accepted. An address saved here is used for this reader only;
// it stays with the payments service, not the practice directory.
function cardReaderAddressMarkup(reason,form){
 const at=cardReaderAddressValues(form);
 return `<form id="card-reader-address-form"><h4>Practice address</h4>${reason?`<p class="muted">${esc(reason)}</p>`:''}<label>Street address<input name="line1" required maxlength="55" autocomplete="off" value="${esc(at.line1)}"></label><label>Suite or unit (optional)<input name="line2" maxlength="55" autocomplete="off" value="${esc(at.line2)}"></label><label>City<input name="city" required maxlength="55" autocomplete="off" value="${esc(at.city)}"></label><label>State<input name="state" required maxlength="2" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(at.state)}"></label><label>ZIP<input name="postal_code" required maxlength="10" autocomplete="off" inputmode="numeric" spellcheck="false" value="${esc(at.postal_code)}"></label><p role="alert" data-address-error${form.error?'':' hidden'}>${esc(form.error||'')}</p><p class="muted">${cardReaderAdminHint}</p><button type="submit" class="primary">Add reader</button><button type="button" data-address-cancel>Cancel</button></form>`;
}
function cardReaderAddressValues(form){
 const at=form?.values||{};
 return {line1:at.line1||'',line2:at.line2||'',city:at.city||'',state:at.state||'',postal_code:at.postal_code||''};
}
function paintCardReaderAddress(){
 let host=document.getElementById('suncharts-dialog-host');
 if(!host){
  if(typeof document.createElement!=='function'||!document.body?.append)return false;
  host=document.createElement('div');host.id='suncharts-dialog-host';document.body.append(host);
 }
 const form=cardReaderAddressForm;
 if(!form){host.hidden=true;host.innerHTML='';return true;}
 host.hidden=false;host.innerHTML=`<div class="app-dialog-backdrop" data-address-cancel></div><section class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="card-reader-address-title"><header><span class="app-dialog-mark" aria-hidden="true">?</span><div><p class="eyebrow">CARD READER SETUP</p><h2 id="card-reader-address-title">Practice address</h2></div></header>${cardReaderAddressMarkup(form.reason,form)}</section>`;
 host.querySelector?.('input[name="line1"]')?.focus?.();
 return true;
}
function openCardReaderAddressForm(reason,code,name,values){
 cardReaderAddressForm={reason,code,name,values:cardReaderAddressValues(values),error:''};
 if(!paintCardReaderAddress())return;
 document.addEventListener('click',cardReaderAddressClick,true);
 document.addEventListener('submit',cardReaderAddressSubmit,true);
}
function closeCardReaderAddressForm(){
 if(!cardReaderAddressForm)return;
 cardReaderAddressForm=null;
 document.removeEventListener('click',cardReaderAddressClick,true);
 document.removeEventListener('submit',cardReaderAddressSubmit,true);
 paintCardReaderAddress();
}
function cardReaderAddressClick(event){
 const control=event.target?.closest?.('button,[data-address-cancel]');if(!control||!cardReaderAddressForm)return;
 const d=control.dataset||{};
 if('addressCancel' in d||'dialogCancel' in d){event.preventDefault();closeCardReaderAddressForm();}
}
// The reader keeps its own pairing code and name; only the request identifier is new, so the
// payments service sees this as another attempt rather than the one it already refused.
async function sendCardReaderAddress(form){
 const state=cardReaderAddressForm;if(!state)return;
 const values=Object.fromEntries(new FormData(form)),address={
  line1:String(values.line1||'').trim(),line2:String(values.line2||'').trim(),
  city:String(values.city||'').trim(),state:String(values.state||'').trim().toUpperCase(),
  postal_code:String(values.postal_code||'').trim(),
 };
 state.values=address;
 try{
  await api(cardReaderListApi,'POST',{request_id:crypto.randomUUID(),code:state.code,name:state.name,location_address:address});
 }catch(error){
  if(cardReaderAddressForm!==state)return;
  state.error=error?.message||'The address was not accepted. Check it and try again.';
  paintCardReaderAddress();
  return;
 }
 closeCardReaderAddressForm();
 notice('Reader added.');
}
function cardReaderAddressSubmit(event){
 const form=event.target;if(form?.id!=='card-reader-address-form')return;
 event.preventDefault();event.stopPropagation();run(()=>sendCardReaderAddress(form));
}
async function removeCardReader(id){
 const state=cardReaderListState;if(!state?.data?.can_manage||!cardReaderById(id))return;
 await api(`${cardReaderListApi}/${encodeURIComponent(id)}`,'DELETE');
 if(cardReaderListState!==state)return;
 await loadCardReaderList();
 notice('Reader removed.');
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button');if(!button?.dataset)return;const d=button.dataset;
 if('addReader' in d){event.preventDefault();openCardReaderForm('add');}
 else if(d.renameReader){event.preventDefault();openCardReaderForm('rename',d.renameReader);}
 else if(d.removeReader){event.preventDefault();openCardReaderForm('remove',d.removeReader);}
 else if('closeReaderForm' in d){event.preventDefault();openCardReaderForm('');}
 else if(d.confirmRemoveReader){event.preventDefault();run(()=>removeCardReader(d.confirmRemoveReader));}
});
document.addEventListener('submit',event=>{
 const form=event.target;if(!['card-reader-add-form','card-reader-rename-form'].includes(form?.id))return;
 event.preventDefault();run(()=>submitCardReaderForm(form));
});

// ---- Take card payment on reader ---------------------------------------------------------------
// Shared by the copay and invoice screens. The server sends the payment to the reader and
// closes it by itself; this only shows where the payment stands and offers Cancel.
const cardReaderRememberKey='suncharts.cardReader';
function rememberedCardReader(){try{return window.localStorage?.getItem(cardReaderRememberKey)||'';}catch{return '';}}
function rememberCardReader(id){try{window.localStorage?.setItem(cardReaderRememberKey,id);}catch{/* The choice is only a convenience. */}}
// The readers a payment can use. With none set up, the owner is taken to Card readers.
async function readersForPayment(){
 const data=await api(cardReaderListApi);
 if(data.status!=='ready'||data.payments_available===false)throw new Error('Card payments on a reader are not available for this practice yet.');
 const readers=data.readers||[];
 if(readers.length)return readers;
 if(me?.role!=='owner')throw new Error('No card reader is set up yet. Ask the practice owner to add one.');
 await openCardReaders();return null;
}
function readerChoiceMarkup(readers){
 const last=rememberedCardReader(),chosen=readers.find(reader=>reader.id===last)||readers.find(reader=>reader.online)||readers[0];
 if(readers.length===1)return `<input type="hidden" name="reader" value="${esc(chosen.id)}"><p>Reader: <b>${esc(chosen.name)}</b>${chosen.online?'':' · Offline'}</p>`;
 return `<label>Reader<select name="reader" required>${readers.map(reader=>`<option value="${esc(reader.id)}" ${reader.id===chosen.id?'selected':''}>${esc(reader.name)}${reader.online?'':' · Offline'}</option>`).join('')}</select></label>`;
}
// What staff read for a reader payment, from its saved status.
function readerPaymentState(operation,readerName){
 const status=operation?.status,result=operation?.last_result;
 if(status==='paid'||status==='refunded')return {key:'approved',text:'Approved',final:true};
 if(status==='needs_review')return {key:'review',text:'Payment needs review',help:'Do not take this payment again until it is reviewed.',final:true};
 if(status==='expired'){
  if(result==='reader_declined')return {key:'declined',text:'Declined - try another card',final:true};
  if(result==='reader_offline')return {key:'offline',text:'Reader is offline',help:'Check that the reader is switched on, then try again.',final:true};
  if(result==='reader_in_use')return {key:'busy',text:'Reader is in use',help:'Wait for the reader to finish, then try again.',final:true};
  if(result==='reader_timed_out')return {key:'cancelled',text:'Cancelled',help:'No card was presented in time.',final:true};
  if(result==='reader_unavailable'||result==='reader_failed')return {key:'failed',text:'Payment was not taken',help:'Nothing was charged. Try again.',final:true};
  return {key:'cancelled',text:'Cancelled',final:true};
 }
 if(result==='reader_offline')return {key:'offline',text:'Reader is offline',help:'Check that the reader is switched on.'};
 if(result==='reader_finishing')return {key:'finishing',text:'Finishing on the reader',locked:true};
 return {key:'waiting',text:`Waiting for card on ${readerName||'the reader'}`};
}
function readerPaymentLabel(operation){return readerPaymentState(operation).text;}
let readerPaymentLive=null;
// The steps a reader payment goes through, shown as it moves: sent, waiting for the card,
// finishing, then the answer. A step that went wrong is shown as stopped, in its own words.
const readerPaymentSteps=['Sent to the reader','Tap, insert or swipe','Processing','Approved'];
function readerPaymentStepsMarkup(state){
 const at={offline:0,busy:0,waiting:1,finishing:2,approved:3,declined:2,failed:2,cancelled:1,review:2}[state.key]??1;
 const stopped=['offline','busy','declined','failed','cancelled','review'].includes(state.key);
 return `<ol class="reader-steps" aria-hidden="true">${readerPaymentSteps.map((label,index)=>`<li class="${index<at||state.key==='approved'&&index===at?'is-done':index===at?(stopped?'is-stopped':'is-current'):''}"><span></span>${esc(index===at&&stopped?state.text:label)}</li>`).join('')}</ol>`;
}
function readerPaymentMarkup(live){
 const state=readerPaymentState(live.operation,live.readerName),operation=live.operation;
 const actions=state.final?(state.key==='approved'?live.approved?.(operation)||'':state.key==='review'?'':'<button type="button" class="primary" data-reader-payment-again>Try again</button>')+'<button type="button" data-reader-payment-close>Close</button>':state.locked?'':'<button type="button" data-reader-payment-cancel>Cancel</button>';
 return `<section class="billing-section reader-payment" data-reader-payment="${esc(state.key)}"><h3>Card payment on reader</h3><p class="reader-amount">${money(operation.amount_cents)}${operation.livemode===false&&testPaymentLabel()?' · '+testPaymentLabel():''}</p>${readerPaymentStepsMarkup(state)}<p role="status" aria-live="polite" class="reader-state"><b>${esc(state.text)}</b></p>${state.help?`<p class="muted">${esc(state.help)}</p>`:''}${live.unreachable?'<p class="muted">Checking again…</p>':''}<div class="actions">${actions}</div></section>`;
}
function paintReaderPayment(){const host=$('reader-payment-live'),live=readerPaymentLive;if(host&&live)host.innerHTML=readerPaymentMarkup(live);return !!host;}
function stopReaderPayment(){if(readerPaymentLive)clearTimeout(readerPaymentLive.timer);readerPaymentLive=null;}
// live: {operation, readerName, statusUrl, cancelUrl, accept(operation), approved(operation), again(), finished(operation)}
function watchReaderPayment(live){
 stopReaderPayment();live.identity=me;readerPaymentLive=live;paintReaderPayment();
 const settle=()=>{if(readerPaymentState(live.operation).final){clearTimeout(live.timer);live.timer=null;live.finished?.(live.operation);return true;}return false;};
 const tick=async()=>{
  if(readerPaymentLive!==live||me!==live.identity)return;
  try{const data=await api(live.statusUrl);if(readerPaymentLive!==live||me!==live.identity)return;live.accept(data.operation);live.operation=data.operation;live.unreachable=false;}
  catch{if(readerPaymentLive!==live)return;live.unreachable=true;}
  // Leaving the screen stops the display only; the payment still finishes or times out by itself.
  if(!paintReaderPayment()){stopReaderPayment();return;}
  if(!settle())live.timer=setTimeout(tick,2000);
 };
 if(!settle())live.timer=setTimeout(tick,2000);
}
async function cancelReaderPayment(){
 const live=readerPaymentLive;if(!live)return;
 const data=await api(live.cancelUrl,'POST',{});if(readerPaymentLive!==live)return;
 live.accept(data.operation);live.operation=data.operation;paintReaderPayment();
 if(readerPaymentState(live.operation).final){clearTimeout(live.timer);live.timer=null;live.finished?.(live.operation);}
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button');if(!button?.dataset)return;const d=button.dataset;
 if('readerPaymentCancel' in d){event.preventDefault();run(cancelReaderPayment);}
 else if('readerPaymentClose' in d){event.preventDefault();const host=$('reader-payment-live');stopReaderPayment();if(host)host.innerHTML='';}
 else if('readerPaymentAgain' in d){event.preventDefault();const again=readerPaymentLive?.again;stopReaderPayment();const host=$('reader-payment-live');if(host)host.innerHTML='';if(again)run(again);}
});

// ---- Card on file ---------------------------------------------------------------------------
// Only a card the patient agreed may be charged later can be charged here. Cards saved before
// that agreement existed stay on file for use with the patient present.
async function savedCardsForCharge(patientId){
 const data=await api(`/api/v1/billing/patients/${encodeURIComponent(patientId)}/payment-profile`);
 if(data.patient_id!==patientId)throw new Error('The cards on file do not match this patient.');
 const cards=data.payment_methods?.status==='available'&&Array.isArray(data.payment_methods.data?.items)?data.payment_methods.data.items:[];
 return {cards:cards.filter(card=>card.charge_later===true&&card.setup_id),inPerson:cards.filter(card=>card.charge_later!==true).length};
}
function savedCardName(card){return `${human(card.brand||'Card')} ending ${card.last4}`;}
function savedCardVisual(card){
 const brand=human(card.brand||'Card'),last4=card.last4||'••••',expires=card.exp_month&&card.exp_year?`${String(card.exp_month).padStart(2,'0')}/${card.exp_year}`:'';
 return `<div class="payment-card payment-card-small" role="img" aria-label="${esc(brand)} card ending ${esc(last4)}${expires?', expires '+esc(expires):''}"><span class="payment-card-chip" aria-hidden="true"></span><span class="payment-card-brand">${esc(brand)}</span><strong class="payment-card-number"><span aria-hidden="true">•••• •••• ••••</span> ${esc(last4)}</strong>${expires?`<span class="payment-card-exp"><small>Expires</small>${esc(expires)}</span>`:''}</div>`;
}
const savedCardInPersonText='Saved for in-person use. Ask the patient to save it again to charge it later.';
function savedCardChoiceMarkup(found){
 if(!found.cards.length)return `<p role="status">${found.inPerson?'The card on file was saved for in-person use. Ask the patient to save it again to charge it later.':'No card on file yet. Save a card under Payment methods first.'}</p>`;
 // The card being charged is shown as a card, the same way it looks under Payment methods.
 if(found.cards.length===1)return `<input type="hidden" name="card" value="${esc(found.cards[0].setup_id)}"><div class="saved-card-choice">${savedCardVisual(found.cards[0])}</div>`;
 return `<fieldset class="saved-card-choice"><legend>Card to charge</legend>${found.cards.map((card,index)=>`<label class="saved-card-pick"><input type="radio" name="card" value="${esc(card.setup_id)}" required${index===0?' checked':''}>${savedCardVisual(card)}</label>`).join('')}</fieldset>`;
}
// What staff read for a charge to a card on file, from its saved status.
function savedCardPaymentState(operation){
 const status=operation?.status,result=operation?.last_result;
 if(status==='paid'||status==='refunded')return {key:'approved',text:'Approved',final:true};
 if(status==='needs_review')return {key:'review',text:'Payment needs review',help:'Do not take this payment again until it is reviewed.',final:true};
 if(status==='expired'){
  if(result==='saved_card_needs_patient')return {key:'confirm',text:'The bank needs the patient to confirm - send a card link instead',help:'Nothing was charged.',final:true};
  if(result==='saved_card_declined')return {key:'declined',text:'Declined',help:'Nothing was charged. Try another card or another way to pay.',final:true};
  if(result==='saved_card_not_eligible')return {key:'in-person',text:'This card was saved for in-person use',help:'Ask the patient to save it again to charge it later.',final:true};
  return {key:'failed',text:'Card was not charged',help:'Nothing was charged. Try again.',final:true};
 }
 return {key:'charging',text:'Charging the card'};
}
function savedCardPaymentLabel(operation){return savedCardPaymentState(operation).text;}
let savedCardPaymentLive=null;
function savedCardPaymentMarkup(live){
 const state=savedCardPaymentState(live.operation),operation=live.operation;
 const next=state.key==='approved'?live.approved?.(operation)||'':state.key==='confirm'&&live.link?'<button type="button" class="primary" data-saved-card-link>Create card link</button>':'';
 return `<section class="billing-section saved-card-payment" data-saved-card-payment="${esc(state.key)}"><h3>Charge card on file</h3><p>${money(operation.amount_cents)}${operation.livemode===false&&testPaymentLabel()?' · '+testPaymentLabel():''}</p><p role="status" aria-live="polite"><b>${esc(state.text)}</b></p>${state.help?`<p class="muted">${esc(state.help)}</p>`:''}${live.error?`<p role="alert">${esc(live.error)}</p>`:''}<div class="actions">${state.final?next+'<button type="button" data-saved-card-close>Close</button>':''}</div></section>`;
}
function paintSavedCardPayment(){const host=$('saved-card-payment-live'),live=savedCardPaymentLive;if(host&&live)host.innerHTML=savedCardPaymentMarkup(live);return !!host;}
function stopSavedCardPayment(){if(savedCardPaymentLive)clearTimeout(savedCardPaymentLive.timer);savedCardPaymentLive=null;}
// live: {operation, refreshUrl, accept(operation), approved(operation), link(operation), finished(operation)}
// The result is drawn where the charge was started. A charge the bank is still working on is
// checked every two seconds; leaving the screen stops the display only.
function watchSavedCardPayment(live){
 stopSavedCardPayment();live.identity=me;savedCardPaymentLive=live;paintSavedCardPayment();
 const settle=()=>{if(savedCardPaymentState(live.operation).final){clearTimeout(live.timer);live.timer=null;live.finished?.(live.operation);return true;}return false;};
 const tick=async()=>{
  if(savedCardPaymentLive!==live||me!==live.identity)return;
  try{const data=await api(live.refreshUrl,'POST',{});if(savedCardPaymentLive!==live||me!==live.identity)return;live.accept?.(data.operation);live.operation=data.operation;}
  catch{if(savedCardPaymentLive!==live)return;}
  if(!paintSavedCardPayment()){stopSavedCardPayment();return;}
  if(!settle())live.timer=setTimeout(tick,2000);
 };
 if(!settle())live.timer=setTimeout(tick,2000);
}
document.addEventListener('click',event=>{
 const button=event.target.closest?.('button');if(!button?.dataset)return;const d=button.dataset;
 if('savedCardClose' in d){event.preventDefault();const host=$('saved-card-payment-live');stopSavedCardPayment();if(host)host.innerHTML='';}
 else if('savedCardLink' in d){event.preventDefault();const live=savedCardPaymentLive;if(!live?.link)return;button.disabled=true;run(async()=>{try{await live.link(live.operation);}catch(error){if(savedCardPaymentLive===live){live.error=error.message||'The card link could not be created. Try again.';paintSavedCardPayment();}}});}
});
