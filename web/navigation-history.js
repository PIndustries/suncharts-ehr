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
  'nav-apps':'showApps','nav-migration':'showMigrations','nav-workflows':'showWorkflowStudio'
 };
 const detailMethods={claim:'showClaim',era:'showEra',eraBatch:'showEraBatch',payment:'openPaymentStatus',paymentSettings:'openPaymentSettings',cardReaders:'openCardReaders',support:'showSupportTicket',portal:'showPortalThread'};
 const screenMethods={sun:'showSunPage',support:'showSupportTickets',connect:'showConnectServices',inbox:'showIntegrationInbox',outbound:'showOutboundWorkspace',previsit:'showPrevisit',reminders:'showReminderWorkspace'};
 const identity=()=>typeof me==='undefined'||!me?null:[me.tenant_id,me.user_id,me.role].join(':');
  let hadSession=false,generation=0,depth=0,restoring=false,current=null,pendingRoute=null,queued=null,restoreRunning=false,bouncing=false;
  const scrollPositions=new Map();
  let initialScroll=null;
 history.scrollRestoration='manual';
 const url=()=>location.pathname+location.search;
 const position=()=>({x:Math.max(0,Math.round(window.scrollX||0)),y:Math.max(0,Math.round(window.scrollY||0))});
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 // Readable addresses: every screen has a #/… address made only of screen names and opaque record
 // identifiers, so Back, Forward, reload and bookmarks land on the same screen. No names, MRNs or
 // clinical content ever enter the address.
 const navSlugs={'nav-practice':'home','nav-schedule':'schedule','nav-followup':'work-queue','nav-portal':'inbox','nav-clinical':'patients','nav-labs':'orders','nav-specialty':'specialty','nav-referrals':'referrals','nav-billing':'billing','nav-claims':'claims','nav-edi':'claim-connections','nav-admin':'practice','nav-apps':'integrations','nav-migration':'data-import','nav-workflows':'workflow-studio'};
 const slugNavs=Object.fromEntries(Object.entries(navSlugs).map(([nav,slug])=>[slug,nav]));
 const screenSlugs={sun:'sun',support:'support',connect:'connect-services',inbox:'messages',outbound:'outbound',previsit:'intake',reminders:'reminders'};
 const detailSlugs={claim:'claims',era:'remittances',eraBatch:'remittance-batches',payment:'payments',paymentSettings:'payment-settings',cardReaders:'card-readers',support:'support',portal:'inbox'};
 const sectionSlugs={overview:'overview',encounters:'encounters',vitals:'vitals',immunizations:'immunizations',history:'surgical-dental-history',source:'imported-records',functional_status:'assessments',specialty_care:'specialty-care',visits:'encounter',insurance:'insurance',billing:'billing',documents:'files',orders:'orders',profile:'record',clinical:'clinical',care_pathways:'care-pathways',prescribing:'prescriptions',referrals:'referrals'};
 const clinicalSlugs={problem:'problems',allergy:'allergies',medication:'medications'};
 const sectionAliases={summary:'overview',profile:'profile',problems:'clinical',allergies:'clinical',medications:'clinical'};
 const billingTabs=['overview','invoices','payments','methods','subscriptions'];
 const missingContactFilters=['address','phone'];
 const claimWorklistFilters=['wait','fix','remittance-review','posted'];
 const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
 const invert=(map,value)=>Object.keys(map).find(key=>map[key]===value);
 const knownQueueKind=kind=>typeof workQueueKinds!=='undefined'&&workQueueKinds.some(([key])=>key===kind);
 function address(route){
  if(!route)return '';
  if(route.view==='tool'){
   if(route.nav==='nav-followup'&&knownQueueKind(route.kind))return '#/work-queue/'+route.kind;
   if(route.nav==='nav-billing'&&route.filter==='collected-today')return '#/billing/collected-today';
   if(route.nav==='nav-practice'&&route.board==='unfinished')return '#/home/unfinished';
   if(route.nav==='nav-claims'&&claimWorklistFilters.includes(route.filter))return '#/claims/'+route.filter;
   if(route.nav==='nav-clinical'&&missingContactFilters.includes(route.missing))return '#/patients/missing-'+route.missing;
   return navSlugs[route.nav]?'#/'+navSlugs[route.nav]:'';
  }
  if(route.view==='patient'){
   if(!uuid(route.patient))return '#/patients';
   let path='#/patients/'+route.patient+'/'+(route.section==='clinical'&&clinicalSlugs[route.focus]?clinicalSlugs[route.focus]:sectionSlugs[route.section]||'overview');
   if(route.section==='visits'&&uuid(route.visit))path+='/'+route.visit+(/^[a-z-]{1,30}$/.test(route.step||'')?'/'+route.step:'');
   if(route.section==='billing'&&billingTabs.includes(route.billing?.tab))path+='/'+route.billing.tab;
   return path;
  }
  if(route.view==='patientBilling')return '#/billing'+(uuid(route.billing?.patient)?'/patients/'+route.billing.patient:'')+(billingTabs.includes(route.billing?.tab)?'/'+route.billing.tab:'');
  if(route.view==='screen'&&route.kind==='previsit'&&route.submitted)return '#/intake/review';
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
   if(parts.length===2&&second.startsWith('missing-')&&missingContactFilters.includes(second.slice(8)))return {view:'tool',nav:'nav-clinical',missing:second.slice(8)};
   if(!uuid(second))return null;
   const section=(Object.hasOwn(sectionAliases,third)?sectionAliases[third]:null)||invert(sectionSlugs,third||'overview');if(!section)return null;
   const route={view:'patient',patient:second,visit:null,section,step:'documentation',appointment:null,claim:null,billing:null,file:null,account:null,order:null};
   if(section==='clinical')route.focus=invert(clinicalSlugs,third)||'problem';
   if(section==='visits'&&uuid(fourth)){route.visit=fourth;if(fifth)route.step=fifth;}
   if(section==='billing')route.billing={patient:second,tab:billingTabs.includes(fourth)?fourth:'overview',surface:'chart',plan:null};
   return route;
  }
  if(head==='billing'&&second==='collected-today'&&parts.length===2)return {view:'tool',nav:'nav-billing',filter:second};
  if(head==='billing'&&(second==='patients'||billingTabs.includes(second))){
   const patient=second==='patients'&&uuid(third)?third:null,tab=second==='patients'?fourth:second;
   return {view:'patientBilling',billing:{patient,tab:billingTabs.includes(tab)?tab:'overview',surface:'global',plan:null}};
  }
  if(head==='work-queue'&&knownQueueKind(second)&&parts.length===2)return {view:'tool',nav:'nav-followup',kind:second};
  if(head==='home'&&second==='unfinished'&&parts.length===2)return {view:'tool',nav:'nav-practice',board:second};
  if(head==='claims'&&claimWorklistFilters.includes(second)&&parts.length===2)return {view:'tool',nav:'nav-claims',filter:second};
  const detail=invert(detailSlugs,head);
  if(detail&&uuid(second))return {view:'detail',kind:detail,id:second};
  if(head==='payment-settings')return {view:'detail',kind:'paymentSettings',id:null};
  if(head==='card-readers'&&!second)return {view:'detail',kind:'cardReaders',id:null};
  if(Object.hasOwn(slugNavs,head)&&!second)return {view:'tool',nav:slugNavs[head]};
  if(head==='intake'&&second==='review'&&parts.length===2)return {view:'screen',kind:'previsit',submitted:true};
  const screen=invert(screenSlugs,head);
  if(screen&&!second)return {view:'screen',kind:screen,...(screen==='inbox'?{channel:'communications'}:screen==='outbound'?{channel:'ringcentral'}:{})};
  return null;
 }
 function state(route,scroll=position()){return {version,identity:identity(),route,scroll,url:url(),index:current?.index||0};}
 function backControl(){const button=$('workspace-back');if(button){button.hidden=!current||!(current.index>0)||(['tool','screen'].includes(current.route?.view)||(current.route?.view==='patient'&&!current.route.patient)||(current.route?.view==='patientBilling'&&!current.route.billing?.patient));button.disabled=restoring;}}
 function replace(value){
  const next={...history.state,[tag]:value},target=value.url+address(value.route);
  if(target===url()+location.hash&&same(history.state,next))return;
  history.replaceState(next,'',target);
 }
 function capturePosition(persist=true){
  if(restoring||depth||!current||current.identity!==identity())return;
  current={...current,scroll:position()};scrollPositions.set(current.index,current.scroll);if(persist)replace(current);
 }
 function patientRoute(){
  if($('clinical-workspace')?.hidden!==false)return null;
  const patient=typeof selected==='undefined'?null:selected||null;
  if(!patient&&typeof patientDirectoryMissing==='string'&&missingContactFilters.includes(patientDirectoryMissing))return {view:'tool',nav:'nav-clinical',missing:patientDirectoryMissing};
  return {view:'patient',patient,
   visit:typeof activeVisit==='undefined'?null:activeVisit?.id||null,
   section:typeof chartSection==='undefined'?'overview':chartSection,
   focus:typeof frameClinicalFocus==='undefined'||chartSection!=='clinical'?null:frameClinicalFocus,
   step:typeof encounterSection==='undefined'?'visit':encounterSection,
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
 function claimsToolRoute(requested){
  const filter=typeof claimStatusFilter==='string'?claimStatusFilter:requested;
  return {view:'tool',nav:'nav-claims',...(claimWorklistFilters.includes(filter)?{filter}:{})};
 }
 const practiceToolRoute=board=>({view:'tool',nav:'nav-practice',...(board==='unfinished'?{board}:{})});
 function queueToolRoute(){
  const kind=typeof workQueueKind==='string'?workQueueKind:'all';
  return {view:'tool',nav:'nav-followup',...(knownQueueKind(kind)?{kind}:{})};
 }
 function billingRoute(){const route=typeof patientBillingRoute==='function'?patientBillingRoute():null;return route?.surface==='global'?{view:'patientBilling',billing:route}:null;}
 function routeNow(){return patientRoute()||billingRoute()||pendingRoute||toolRoute();}
 function remember(){
  if(restoring||depth||typeof busy!=='undefined'&&busy||!identity())return;
  const route=routeNow();if(!route)return;
  const next=state(route);
  if(!current||current.identity!==next.identity){replace(next);current=next;backControl();return;}
  if(same(current.route,route)){current={...next,scroll:current.scroll};replace(current);backControl();return;}
  // Scroll events have already saved the prior entry; navigation writes only the destination.
  next.index=(current.index||0)+1;for(const index of scrollPositions.keys())if(index>=next.index)scrollPositions.delete(index);const nextUrl=next.url;history.pushState({...history.state,[tag]:next},'',nextUrl+address(next.route));current=next;backControl();
 }
 function wrap(name,route){
  const original=window[name];if(typeof original!=='function')return;
  window[name]=function(...args){
   capturePosition(false);const started=generation,actor=identity();depth++;
   const release=()=>{if(started===generation)depth--;};
   const finish=()=>{
    release();if(started!==generation||(actor!==identity()&&name!=='enter'&&!(name==='run'&&!actor)))return;
    if(route){const value=route(args);if(value)pendingRoute=value;}
    if(name==='enter'&&identity())hadSession=true;
    remember();
   };
   let result;try{result=original.apply(this,args);}catch(error){release();throw error;}
   if(result&&typeof result.then==='function')return result.then(value=>{finish();return value;},error=>{release();throw error;});
   finish();return result;
  };
 }
 async function invoke(name,...args){if(typeof window[name]!=='function')throw new Error('This screen is not available.');return window[name](...args);}
 async function restoreRoute(route,valid,openLink=false){
  if(!route||typeof route!=='object')throw new Error('This history entry is unavailable.');
  if(route.view==='patient'){
   // The chart pane always has something to show, so an address that names no
   // record — the patient directory — is settled here rather than opened.
   const opens=Boolean(route.patient);
   if(!opens){selected=undefined;activeVisit=undefined;workspace=undefined;chartSection='overview';$('chart').innerHTML='<div class="panel empty"><h2>Open a patient chart</h2><p>Select a patient from the directory.</p></div>';}
   const alreadyOpen=opens&&typeof selected!=='undefined'&&selected===route.patient&&typeof workspace!=='undefined'&&Boolean(workspace);
   if(!opens)await invoke('showClinical');
   else if(alreadyOpen&&$('clinical-workspace')?.hidden){
    await invoke('setPage','Patients & encounters');
    $('clinical-workspace').hidden=false;
    if($('tools'))$('tools').hidden=true;
    if(typeof frameRenderPatients==='function')frameRenderPatients();
   }
   if(!valid())return;
   if(!opens)return;
   // A chart that is gone, or not visible to this person, is not announced as a
   // failure: staff are left on the patient directory instead.
   try{
    if(!alreadyOpen){
     // A fresh patient-wide address has no visit parameter. Use the chart's normal
     // open-visit selection; a saved history entry still restores its exact choice.
     const visit=route.visit||((openLink&&['billing','insurance'].includes(route.section))?undefined:null);
     await invoke('selectPatient',route.patient,visit,valid,route);
    }
    else if(route.visit&&route.visit!==activeVisit?.id)await invoke('openPatientEncounter',route.visit);
   }
   catch(error){
    if(!valid())return;
    if(![403,404,410].includes(error?.status))throw error;
    await invoke('showClinical');return;
   }
   if(!valid())return;
   if(route.visit&&!activeVisit){
    // The encounter this step belonged to is gone. The chart returns to the patient
    // record and the address drops the encounter it can no longer open.
    showChartSection('overview');
    return;
   }
   if(route.section==='insurance'&&typeof insuranceAppointmentSelection!=='undefined'){
    insuranceAppointmentSelection.delete(route.patient);
    if(route.appointment&&workspace.appointments?.some(a=>a.id===route.appointment))insuranceAppointmentSelection.set(route.patient,route.appointment);
   }
   showChartSection(route.section==='clinical'&&clinicalSlugs[route.focus]?route.focus:route.section||'overview');
   if(chartSection==='visits'&&activeVisit)setEncounterSection(route.step||'documentation',{openLink:openLink&&!route.claim});
   if(valid()&&route.billing&&chartSection==='billing')await invoke('restorePatientBillingRoute',route.billing);
   if(!route.billing&&route.account&&workspace.billing?.accounts.some(a=>a.id===route.account))showBillingAccount(route.account,false);
   if(route.order&&workspace.labs?.orders.some(o=>o.id===route.order))showOrder(route.order,false);
   if(route.claim&&chartSection==='visits'&&typeof encounterShows==='function'&&encounterShows('charges')&&workspace.billing?.accounts.some(a=>a.id===route.claim.account&&a.content.visit_id===activeVisit?.id)){
    if(route.claim.claim)await invoke('showEncounterClaim',route.claim.claim,route.claim.account);
    else await invoke('beginClaim',route.claim.account);
   }
   if(valid()&&route.file&&(chartSection==='documents'||chartSection==='visits'&&encounterSection==='files'))await invoke('restoreEncounterFileRoute',route.file);
   return;
  }
  if(route.view==='patientBilling'){await invoke('restorePatientBillingRoute',route.billing);return;}
  if(route.view==='tool'&&route.nav==='nav-followup'&&route.kind){await invoke('showFollowupWorkspace',{kind:route.kind});return;}
  if(route.view==='tool'&&route.nav==='nav-billing'&&route.filter==='collected-today'){
   if(typeof billingOverviewAllowed==='function'&&!billingOverviewAllowed('billing'))throw Object.assign(new Error('Your role does not have access to patient payments.'),{status:403});
   await invoke('renderBillingOverview',null,null,{practiceWide:true,view:'collected'});return;
  }
  if(route.view==='tool'&&route.nav==='nav-practice'&&route.board){await invoke('showPracticeWorkspace',{board:route.board});return;}
  if(route.view==='tool'&&route.nav==='nav-claims'&&route.filter){await invoke('showClaimsWorkspace',{filter:route.filter});return;}
  if(route.view==='tool'&&route.nav==='nav-clinical'&&route.missing){await invoke('openMissingPatients',route.missing);return;}
  if(route.view==='tool'&&toolsByNav[route.nav]){await invoke(toolsByNav[route.nav]);return;}
  if(route.view==='screen'&&screenMethods[route.kind]){
   if(route.kind==='reminders'&&typeof reminderFilter!=='undefined'&&typeof route.filter==='string')reminderFilter=route.filter;
   if(route.kind==='previsit'&&route.submitted){await invoke(screenMethods.previsit,{submitted:true});return;}
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
    const target={...queued,scroll:scrollPositions.get(queued.index)||queued.scroll},started=generation;queued=null;
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
    await run(async()=>{await restoreRoute(target.route,valid,target.openLink);restored=valid();});
    if(!valid())continue;
    if(!restored){current=null;continue;}
    current={...target,url:url(),route:routeNow()||target.route};pendingRoute=current.route;replace(current);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(valid()&&!queued)window.scrollTo({left:Math.min(target.scroll?.x||0,10000000),top:Math.min(target.scroll?.y||0,10000000),behavior:'instant'});
   }
  }finally{restoring=false;restoreRunning=false;remember();backControl();}
 }
  // Open the screen named by the address bar: a bookmark, a pasted link, or an edited address.
  function openAddress(){
   const route=routeFromAddress(location.hash);if(!route||!identity())return false;
   if(current&&same(current.route,route))return false;
   queued={version,identity:identity(),route,scroll:{x:0,y:0},url:url(),index:current?.index||0,openLink:true};void drain();return true;
  }
 // Choose the initial route before displaying a workspace. Browser history enriches a URL
 // only when the saved route belongs to the authenticated staff member and matches the URL.
 window.restoreInitialWorkspaceRoute=async function(){
  const actor=identity(),started=generation,hash=location.hash,saved=history.state?.[tag];
  const unavailable=()=>{pendingRoute=null;history.replaceState(null,'',url());return false;};
  if(!actor)return false;
  if(saved?.identity&&saved.url===url()&&saved.identity!==actor)return unavailable();
  const matches=saved?.identity===actor&&saved.version===version&&saved.url===url()&&address(saved.route)===hash;
  const route=matches?saved.route:routeFromAddress(hash);
  if(!route)return false;
  const valid=()=>generation===started&&identity()===actor;
  const module=route.view==='tool'?route.nav.slice(4):route.view==='patient'?'clinical':route.view==='patientBilling'?'billing':
   route.view==='detail'?({claim:'claims',era:'claims',eraBatch:'claims',payment:'billing',paymentSettings:'billing',cardReaders:'billing',portal:'portal'})[route.kind]:
   ({inbox:'communications',outbound:'communications',previsit:'schedule',reminders:'schedule'})[route.kind];
  if((module==='admin'||route.kind==='cardReaders')&&me.role!=='owner')return unavailable();
  if(module&&typeof workspaceModuleAllowed==='function'&&!workspaceModuleAllowed(module))return unavailable();
  try{await restoreRoute(route,valid,!matches);}
  catch(error){
   if(!valid())return true;
   if([403,404,410].includes(error?.status))return unavailable();
   throw error;
  }
  if(!valid())return true;
  initialScroll=matches?saved.scroll:{x:0,y:0};
  current={...state(routeNow()||route,initialScroll),index:matches?saved.index:0};
  replace(current);backControl();return true;
 };
 window.restoreInitialWorkspaceScroll=function(){
  if(!initialScroll)return;
  window.scrollTo({left:Math.min(initialScroll.x||0,10000000),top:Math.min(initialScroll.y||0,10000000),behavior:'instant'});
  initialScroll=null;
 };
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
 wrap('renderBillingOverview',args=>args[2]?.view==='collected'?{view:'tool',nav:'nav-billing',filter:'collected-today'}:toolRoute());
 for(const name of ['showPatientBillingWorkspace','changePatientBillingTab','renderPatientBillingChart'])wrap(name,()=>billingRoute()||patientRoute());
 for(const name of ['showClinical','frameSelectPatient','selectPatient','focusClinicalSection','showChartSection','setEncounterSection','renderVisit','showBillingAccount','showOrder','showEncounterClaim','beginClaim','openDocumentFile'])wrap(name,()=>patientRoute());
 wrap('selectPracticeBoard',args=>practiceToolRoute(args[0]));
 wrap('selectWorkQueueKind',queueToolRoute);
 wrap('showFollowupWorkspace',queueToolRoute);
 wrap('showPracticeWorkspace',args=>practiceToolRoute(args[0]?.board));
 for(const [nav,name] of Object.entries(toolsByNav))if(!['showClinical','showPracticeWorkspace','showFollowupWorkspace'].includes(name))wrap(name,nav==='nav-claims'?args=>claimsToolRoute(args[0]?.filter):()=>({view:'tool',nav}));
 wrap('selectClaimStatusFilter',args=>{
  const route=pendingRoute||current?.route;
  return route?.view==='tool'&&route.nav==='nav-claims'?claimsToolRoute(args[0]):null;
 });
 for(const [kind,name] of Object.entries(screenMethods))wrap(name,args=>({view:'screen',kind,...(kind==='previsit'&&args[0]?.submitted?{submitted:true}:kind==='inbox'?{channel:args[0]||'communications'}:kind==='outbound'?{channel:args[0]||'ringcentral'}:kind==='reminders'?{filter:typeof reminderFilter==='undefined'?'due':reminderFilter}:{})}));
 for(const [kind,name] of Object.entries(detailMethods))wrap(name,args=>({view:'detail',kind,id:['paymentSettings','cardReaders'].includes(kind)?null:args[0]}));
 const originalSignIn=window.signInScreen;
 if(typeof originalSignIn==='function')window.signInScreen=function(sessionEnded){const savedIdentity=history.state?.[tag]?.identity,previous=hadSession||identity()||savedIdentity;generation++;scrollPositions.clear();depth=0;current=null;pendingRoute=null;queued=null;initialScroll=null;backControl();
  // After a session ends, the previous person's screen address must not open for the next person.
  if(previous&&location.hash.startsWith('#/'))history.replaceState(null,'',url());
  return originalSignIn.call(this,sessionEnded===false&&Boolean(savedIdentity)||sessionEnded);};
 document.addEventListener('change',event=>{if(event.target.id==='insurance-appointment')remember();});
 // Keep reading positions in memory, without extra history writes after section scrolling.
 let scrollPending=false;
 window.addEventListener('scroll',()=>{if(scrollPending)return;scrollPending=true;requestAnimationFrame(()=>{scrollPending=false;capturePosition(false);});},{passive:true});
 window.addEventListener('pagehide',()=>capturePosition());
 // Optional in-app Back control uses exactly the same browser history.
 document.addEventListener('click',event=>{if(event.target.closest?.('[data-workspace-back]')){event.preventDefault();history.back();}});
})();
