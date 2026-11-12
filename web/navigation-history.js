// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// History stores only view identifiers; clinical content and drafts stay in memory.
(()=>{
 const tag='sunchartsNavigation',version=1;
 const toolsByNav={
  'nav-practice':'showPracticeWorkspace','nav-schedule':'showSchedule','nav-followup':'showFollowupWorkspace',
  'nav-portal':'showPortalInbox','nav-clinical':'showClinical','nav-labs':'showLabInbox',
  'nav-specialty':'showSpecialtyWorklist','nav-referrals':'showReferralWorkspace','nav-billing':'showBillingQueue',
  'nav-claims':'showClaimsWorkspace','nav-edi':'showEdiWorkspace','nav-admin':'showPracticeAdmin',
  'nav-apps':'showApps','nav-migration':'showMigrations','nav-workflows':'showWorkflowStudio',
  'nav-automation':'showAutomationCenter','nav-ai-review':'showAiReviewWorkspace'
 };
 const detailMethods={claim:'showClaim',era:'showEra',eraBatch:'showEraBatch',payment:'openPaymentStatus',paymentSettings:'openPaymentSettings',support:'showSupportTicket',portal:'showPortalThread'};
 const screenMethods={sun:'showSunPage',support:'showSupportTickets',connect:'showConnectServices',inbox:'showIntegrationInbox',outbound:'showOutboundWorkspace',previsit:'showPrevisit',reminders:'showReminderWorkspace'};
 const identity=()=>typeof me==='undefined'||!me?null:[me.tenant_id,me.user_id,me.role].join(':');
 let hadSession=false,generation=0,depth=0,restoring=false,current=null,pendingRoute=null,queued=null,restoreRunning=false,bouncing=false;
 const initial=history.state?.[tag];let initialPending=Boolean(initial);
 history.scrollRestoration='manual';
 const url=()=>location.pathname+location.search;
 const position=()=>({x:Math.max(0,Math.round(window.scrollX||0)),y:Math.max(0,Math.round(window.scrollY||0))});
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 // Readable addresses: every screen has a #/… address made only of screen names and opaque record
 // identifiers, so Back, Forward, reload and bookmarks land on the same screen. No names, MRNs or
 // clinical content ever enter the address.
 const navSlugs={'nav-practice':'home','nav-schedule':'schedule','nav-followup':'work-queue','nav-portal':'inbox','nav-clinical':'patients','nav-labs':'orders','nav-specialty':'specialty','nav-referrals':'referrals','nav-billing':'billing','nav-claims':'claims','nav-edi':'claim-connections','nav-admin':'practice','nav-apps':'integrations','nav-migration':'data-import','nav-workflows':'workflow-studio','nav-automation':'automation','nav-ai-review':'ai-review'};
 const slugNavs=Object.fromEntries(Object.entries(navSlugs).map(([nav,slug])=>[slug,nav]));
 const screenSlugs={sun:'sun',support:'support',connect:'connect-services',inbox:'messages',outbound:'outbound',previsit:'intake',reminders:'reminders'};
 const detailSlugs={claim:'claims',era:'remittances',eraBatch:'remittance-batches',payment:'payments',paymentSettings:'payment-settings',support:'support',portal:'inbox'};
 const sectionSlugs={overview:'overview',visits:'encounter',insurance:'insurance',billing:'billing',documents:'files',orders:'orders',profile:'record',clinical:'clinical',care_pathways:'care-pathways',prescribing:'prescriptions',referrals:'referrals'};
 const billingTabs=['overview','invoices','payments','methods','subscriptions'];
 const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
 const invert=(map,value)=>Object.keys(map).find(key=>map[key]===value);
 function address(route){
  if(!route)return '';
  if(route.view==='tool')return navSlugs[route.nav]?'#/'+navSlugs[route.nav]:'';
  if(route.view==='patient'){
   if(!uuid(route.patient))return '#/patients';
   let path='#/patients/'+route.patient+'/'+(sectionSlugs[route.section]||'overview');
   if(route.section==='visits'&&uuid(route.visit))path+='/'+route.visit+(/^[a-z-]{1,30}$/.test(route.step||'')?'/'+route.step:'');
   if(route.section==='billing'&&billingTabs.includes(route.billing?.tab))path+='/'+route.billing.tab;
   return path;
  }
  if(route.view==='patientBilling')return '#/billing'+(uuid(route.billing?.patient)?'/patients/'+route.billing.patient:'')+(billingTabs.includes(route.billing?.tab)?'/'+route.billing.tab:'');
  if(route.view==='screen')return screenSlugs[route.kind]?'#/'+screenSlugs[route.kind]:'';
  if(route.view==='detail')return detailSlugs[route.kind]?'#/'+detailSlugs[route.kind]+(uuid(route.id)?'/'+route.id:''):'';
  return '';
 }
 function routeFromAddress(hash){
  if(typeof hash!=='string'||!hash.startsWith('#/')||hash.length>200)return null;
  const parts=hash.slice(2).split('/').filter(Boolean);if(!parts.length||parts.some(part=>!/^[a-z0-9-]{1,40}$/i.test(part)))return null;
  const [head,second,third,fourth,fifth]=parts;
  if(head==='patients'){
   if(!second)return {view:'tool',nav:'nav-clinical'};
   if(!uuid(second))return null;
   const section=invert(sectionSlugs,third||'overview');if(!section)return null;
   const route={view:'patient',patient:second,visit:null,section,step:'documentation',appointment:null,claim:null,billing:null,file:null,account:null,order:null};
   if(section==='visits'&&uuid(fourth)){route.visit=fourth;if(fifth)route.step=fifth;}
   if(section==='billing')route.billing={patient:second,tab:billingTabs.includes(fourth)?fourth:'overview',surface:'chart',plan:null};
   return route;
  }
  if(head==='billing'&&(second==='patients'||billingTabs.includes(second))){
   const patient=second==='patients'&&uuid(third)?third:null,tab=second==='patients'?fourth:second;
   return {view:'patientBilling',billing:{patient,tab:billingTabs.includes(tab)?tab:'overview',surface:'global',plan:null}};
  }
  const detail=invert(detailSlugs,head);
  if(detail&&uuid(second))return {view:'detail',kind:detail,id:second};
  if(head==='payment-settings')return {view:'detail',kind:'paymentSettings',id:null};
  if(slugNavs[head]&&!second)return {view:'tool',nav:slugNavs[head]};
  const screen=invert(screenSlugs,head);
  if(screen&&!second)return {view:'screen',kind:screen,...(screen==='inbox'?{channel:'communications'}:screen==='outbound'?{channel:'ringcentral'}:{})};
  return null;
 }
 function state(route,scroll=position()){return {version,identity:identity(),route,scroll,url:url(),index:current?.index||0};}
 function backControl(){const button=$('workspace-back');if(button){button.hidden=!current||!(current.index>0);button.disabled=restoring;}}
 function replace(value){history.replaceState({...history.state,[tag]:value},'',value.url+address(value.route));}
 function capturePosition(){
  if(restoring||depth||!current||current.identity!==identity())return;
  current={...current,scroll:position()};replace(current);
 }
 function patientRoute(){
  if($('clinical-workspace')?.hidden!==false)return null;
  return {view:'patient',patient:typeof selected==='undefined'?null:selected||null,
   visit:typeof activeVisit==='undefined'?null:activeVisit?.id||null,
   section:typeof chartSection==='undefined'?'overview':chartSection,
   step:typeof encounterSection==='undefined'?'documentation':encounterSection,
   appointment:typeof insuranceAppointmentSelection==='undefined'||chartSection!=='insurance'?null:insuranceAppointmentSelection.get(selected)||null,
   claim:typeof encounterClaimRoute==='function'?encounterClaimRoute():null,
   billing:typeof patientBillingRoute==='function'&&chartSection==='billing'?patientBillingRoute():null,
   file:typeof encounterFileRoute==='function'?encounterFileRoute():null,
   account:typeof billingSelected==='undefined'||chartSection!=='billing'?null:billingSelected||null,
   order:typeof labSelected==='undefined'||!['orders','visits'].includes(chartSection)?null:labSelected||null};
 }
 function toolRoute(){
  const active=document.querySelector('#workspace-navigation [aria-current="page"]')?.id;
  return toolsByNav[active]?{view:'tool',nav:active}:null;
 }
 function billingRoute(){const route=typeof patientBillingRoute==='function'?patientBillingRoute():null;return route?.surface==='global'?{view:'patientBilling',billing:route}:null;}
 function routeNow(){return patientRoute()||billingRoute()||pendingRoute||toolRoute();}
 function remember(){
  if(restoring||depth||typeof busy!=='undefined'&&busy||!identity())return;
  const route=routeNow();if(!route)return;
  const next=state(route);
  if(!current||current.identity!==next.identity){replace(next);current=next;backControl();return;}
  if(same(current.route,route)){current={...next,scroll:current.scroll};replace(current);backControl();return;}
  // Older screens replace URL parameters. Preserve the prior entry before pushing.
  next.index=(current.index||0)+1;const nextUrl=next.url;replace(current);history.pushState({...history.state,[tag]:next},'',nextUrl+address(next.route));current=next;backControl();
 }
 function wrap(name,route){
  const original=window[name];if(typeof original!=='function')return;
  window[name]=function(...args){
   capturePosition();const started=generation,actor=identity();depth++;
   const release=()=>{if(started===generation)depth--;};
   const finish=()=>{
    release();if(started!==generation||(actor!==identity()&&name!=='enter'&&!(name==='run'&&!actor)))return;
    if(route){const value=route(args);if(value)pendingRoute=value;}
    if(name==='enter'&&initialPending){initialPending=false;if(initial.identity===identity()&&initial.version===version&&initial.url===url()){queued=initial;void drain();return;}}
    if(name==='enter'){hadSession=true;if(openAddress())return;}
    remember();
   };
   let result;try{result=original.apply(this,args);}catch(error){release();throw error;}
   if(result&&typeof result.then==='function')return result.then(value=>{finish();return value;},error=>{release();throw error;});
   finish();return result;
  };
 }
 async function invoke(name,...args){if(typeof window[name]!=='function')throw new Error('This screen is not available.');return window[name](...args);}
 async function restoreRoute(route,valid){
  if(!route||typeof route!=='object')throw new Error('This history entry is unavailable.');
  if(route.view==='patient'){
   if(!route.patient){selected=undefined;activeVisit=undefined;workspace=undefined;$('chart').innerHTML='<div class="panel empty"><h2>Open a patient chart</h2><p>Select a patient from the directory.</p></div>';}
   await invoke('showClinical');
   if(!valid())return;
   if(route.patient){
    await invoke('selectPatient',route.patient,route.visit||null);
    if(!valid())return;
    if(route.visit&&!activeVisit)throw new Error('The earlier encounter is no longer available.');
    if(route.section==='insurance'&&typeof insuranceAppointmentSelection!=='undefined'){
     insuranceAppointmentSelection.delete(route.patient);
     if(route.appointment&&workspace.appointments?.some(a=>a.id===route.appointment))insuranceAppointmentSelection.set(route.patient,route.appointment);
    }
    showChartSection(route.section||'overview');
    if(chartSection==='visits'&&activeVisit)setEncounterSection(route.step||'documentation');
    if(valid()&&route.billing&&chartSection==='billing')await invoke('restorePatientBillingRoute',route.billing);
    if(!route.billing&&route.account&&workspace.billing?.accounts.some(a=>a.id===route.account))showBillingAccount(route.account,false);
    if(route.order&&workspace.labs?.orders.some(o=>o.id===route.order))showOrder(route.order,false);
    if(route.claim&&chartSection==='visits'&&encounterSection==='charges'&&workspace.billing?.accounts.some(a=>a.id===route.claim.account&&a.content.visit_id===activeVisit?.id)){
     if(route.claim.claim)await invoke('showEncounterClaim',route.claim.claim,route.claim.account);
     else await invoke('beginClaim',route.claim.account);
    }
    if(valid()&&route.file&&(chartSection==='documents'||chartSection==='visits'&&encounterSection==='files'))await invoke('restoreEncounterFileRoute',route.file);
   }
   return;
  }
  if(route.view==='patientBilling'){await invoke('restorePatientBillingRoute',route.billing);return;}
  if(route.view==='tool'&&toolsByNav[route.nav]){await invoke(toolsByNav[route.nav]);return;}
  if(route.view==='screen'&&screenMethods[route.kind]){
   if(route.kind==='reminders'&&typeof reminderFilter!=='undefined'&&typeof route.filter==='string')reminderFilter=route.filter;
   await invoke(screenMethods[route.kind],...(['inbox','outbound'].includes(route.kind)?[route.channel]:[]));return;
  }
  if(route.view==='detail'&&detailMethods[route.kind]){
   await invoke(['claim','era','eraBatch'].includes(route.kind)?'showClaimsWorkspace':route.kind==='support'?'showSupportTickets':route.kind==='portal'?'showPortalInbox':'showBillingQueue');
   if(!valid())return;
   await invoke(detailMethods[route.kind],route.id);return;
  }
  throw new Error('This history entry is unavailable.');
 }
 async function drain(){
  if(restoreRunning)return;restoreRunning=true;restoring=true;backControl();
  try{
   while(queued){
    if(typeof busy!=='undefined'&&busy){await new Promise(resolve=>setTimeout(resolve,30));continue;}
    const target=queued,started=generation;queued=null;
    const valid=()=>started===generation&&target.identity===identity();
    if(!identity()||target.identity!==identity()||target.version!==version){
     if(identity())await invoke('showPracticeWorkspace');
     current=null;pendingRoute=null;continue;
    }
    if(typeof beforeWorkspaceHistoryRestore==='function'&&await beforeWorkspaceHistoryRestore()===false){
     queued=null;const delta=current&&current.identity===target.identity?current.index-target.index:0;
     if(delta){bouncing=true;history.go(delta);}else if(current)replace(current);
     break;
    }
    if(!valid())continue;
    captureVisitDrafts();
    let restored=false;
    await run(async()=>{await restoreRoute(target.route,valid);restored=valid();});
    if(!valid())continue;
    if(!restored){current=null;continue;}
    current={...target,url:url()};pendingRoute=target.route;replace(current);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(valid()&&!queued)window.scrollTo({left:Math.min(target.scroll?.x||0,10000000),top:Math.min(target.scroll?.y||0,10000000),behavior:'instant'});
   }
  }finally{restoring=false;restoreRunning=false;remember();backControl();}
 }
 // Open the screen named by the address bar: a bookmark, a pasted link, or an edited address.
 function openAddress(){
  const route=routeFromAddress(location.hash);if(!route||!identity())return false;
  if(current&&same(current.route,route))return false;
  queued={version,identity:identity(),route,scroll:{x:0,y:0},url:url(),index:current?.index||0};void drain();return true;
 }
 window.addEventListener('hashchange',()=>{if(!restoring&&!depth)openAddress();});
 // A browser Back/Forward action reads saved data; it never repeats a form submission.
 window.addEventListener('popstate',event=>{
  if(bouncing){bouncing=false;return;}
  const target=event.state?.[tag];if(!target)return;
  captureVisitDrafts();queued=target;void drain();
 });
 wrap('run');
 wrap('enter');
 wrap('showTool',()=>toolRoute());
 for(const name of ['showPatientBillingWorkspace','changePatientBillingTab','renderPatientBillingChart'])wrap(name,()=>billingRoute()||patientRoute());
 for(const name of ['showClinical','selectPatient','showChartSection','setEncounterSection','renderVisit','showBillingAccount','showOrder','showEncounterClaim','beginClaim','openDocumentFile'])wrap(name,()=>patientRoute());
 for(const [nav,name] of Object.entries(toolsByNav))if(name!=='showClinical')wrap(name,()=>({view:'tool',nav}));
 for(const [kind,name] of Object.entries(screenMethods))wrap(name,args=>({view:'screen',kind,...(kind==='inbox'?{channel:args[0]||'communications'}:kind==='outbound'?{channel:args[0]||'ringcentral'}:kind==='reminders'?{filter:typeof reminderFilter==='undefined'?'due':reminderFilter}:{})}));
 for(const [kind,name] of Object.entries(detailMethods))wrap(name,args=>({view:'detail',kind,id:kind==='paymentSettings'?null:args[0]}));
 const originalSignIn=window.signInScreen;
 if(typeof originalSignIn==='function')window.signInScreen=function(...args){generation++;depth=0;current=null;pendingRoute=null;queued=null;backControl();
  // After a session ends, the previous person's screen address must not open for the next person.
  if(hadSession&&location.hash.startsWith('#/'))history.replaceState(null,'',url());return originalSignIn.apply(this,args);};
 document.addEventListener('change',event=>{if(event.target.id==='insurance-appointment')remember();});
 // Keep the position current without adding history entries while the user reads.
 let scrollPending=false;
 window.addEventListener('scroll',()=>{if(scrollPending)return;scrollPending=true;requestAnimationFrame(()=>{scrollPending=false;capturePosition();});},{passive:true});
 // Optional in-app Back control uses exactly the same browser history.
 document.addEventListener('click',event=>{if(event.target.closest?.('[data-workspace-back]')){event.preventDefault();history.back();}});
})();
