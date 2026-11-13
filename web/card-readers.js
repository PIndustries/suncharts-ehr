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
 show(page('<div id="card-reader-status"></div><section class="billing-section"><h3>Order a reader</h3><div id="card-reader-shop"></div></section><section class="billing-section"><h3>Your orders</h3><div id="card-reader-orders"></div></section>'));
 try{mountCardReaders(cardReaderConnect(stripe,data,identity),current);}
 catch{endCardReaderConnection();show(page(cardReaderFailure(cardReaderLoadFailure)));}
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
let cardReaderListState=null;
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
 const state=cardReaderListState={data:null,failed:false,form:''};
 try{state.data=await api(cardReaderListApi);}catch{state.failed=true;}
 if(cardReaderListState===state&&current())paintCardReaderList();
 return state.data;
}
// The preview build is marked in the sidebar by the server; production never carries the mark.
function cardReaderPreviewBuild(){
 try{return /^Development preview/.test(document.querySelector?.('.sidebar-source .preview')?.textContent||'');}catch{return false;}
}
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
  await api(cardReaderListApi,'POST',{request_id:cardReaderAddRequest.id,code,name});
  cardReaderAddRequest=null;
 }else await api(`${cardReaderListApi}/${encodeURIComponent(form.dataset.reader)}`,'PUT',{name});
 if(cardReaderListState!==state)return;
 await loadCardReaderList();
 notice(form.id==='card-reader-add-form'?'Reader added.':'Reader renamed.');
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
function readerPaymentMarkup(live){
 const state=readerPaymentState(live.operation,live.readerName),operation=live.operation;
 const actions=state.final?(state.key==='approved'?live.approved?.(operation)||'':state.key==='review'?'':'<button type="button" class="primary" data-reader-payment-again>Try again</button>')+'<button type="button" data-reader-payment-close>Close</button>':state.locked?'':'<button type="button" data-reader-payment-cancel>Cancel</button>';
 return `<section class="billing-section reader-payment" data-reader-payment="${esc(state.key)}"><h3>Card payment on reader</h3><p>${money(operation.amount_cents)}${operation.livemode===false?' · Test payment':''}</p><p role="status" aria-live="polite"><b>${esc(state.text)}</b></p>${state.help?`<p class="muted">${esc(state.help)}</p>`:''}${live.unreachable?'<p class="muted">Checking again…</p>':''}<div class="actions">${actions}</div></section>`;
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
