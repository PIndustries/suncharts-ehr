// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const feeRequests=new WeakMap(),feeTimers=new WeakMap();let feeAdminState=null;
function renderFeeScheduleAdminEntry(){return me?.role==='owner'?'<button type="button" data-fees-manage>Practice fees</button>':'';}
function feeLineMarkup(line){const s=line.fee_snapshot;return `<div data-fee-line data-fee-schedule="${esc(line.fee_schedule_id||'')}" data-fee-entry="${esc(line.fee_entry_key||'')}" data-fee-expected="${s?.expected_line_amount_cents??''}" data-fee-preserved="${line.amount_cents==null?'':'true'}"><p data-fee-status class="muted">${s?`Saved fee: ${esc(s.schedule?.name||'Approved schedule')} · ${money(s.unit_amount_cents)} per unit. Saved amounts are retained.`:'Your practice prices can fill in an empty amount. Otherwise type the amount for the line.'}</p><button type="button" data-fee-check>Use practice price</button><button type="button" data-fee-apply hidden>Use approved fee</button><button type="button" data-fee-manual ${line.fee_schedule_id?'':'hidden'}>Use manual pricing for this code</button><label data-fee-override ${line.fee_override_reason?'':'hidden'}>Reason for overriding approved fee<input name="fee_override_reason" maxlength="1000" value="${esc(line.fee_override_reason||'')}"></label></div>`;}
function feeContextMarkup(value){return `<fieldset data-fee-context data-saved-facility="${esc(value?.facility_id||'')}" data-saved-setting="${esc(value?.setting||'')}"><legend>Practice fee context</legend><p class="muted">Choose where the encounter took place.</p><div class="form-grid"><label>Service facility<select name="fee_facility"><option value="">Choose facility</option></select></label><label>Service setting<select name="fee_setting"><option value="">Choose setting</option><option value="nonfacility" ${value?.setting==='nonfacility'?'selected':''}>Non-facility / office</option><option value="facility" ${value?.setting==='facility'?'selected':''}>Facility</option></select></label></div><p data-fee-context-status class="muted"></p></fieldset>`;}
function feeContextValue(form){const facility=form.querySelector('[name="fee_facility"]')?.value,setting=form.querySelector('[name="fee_setting"]')?.value;return facility&&setting?{facility_id:facility,setting}:null;}
function feeLineValue(row){const host=row.querySelector('[data-fee-line]');if(!host?.dataset.feeSchedule)return {};return {fee_schedule_id:host.dataset.feeSchedule,fee_entry_key:host.dataset.feeEntry,...(host.querySelector('[name="fee_override_reason"]')?.value?{fee_override_reason:host.querySelector('[name="fee_override_reason"]').value}:{})};}
function feeFormCurrent(form,identity,patient){return me===identity&&selected===patient&&form?.isConnected&&form.dataset.patient===patient&&!form.dataset.draftReadOnly&&!form.dataset.draftStale;}
function feeQuery(form,row,context=feeContextValue(form)){const value=n=>row.querySelector(`[name="${n}"]`)?.value;const visit=form.elements.visit_id?.value,date=form.elements.service_date?.value;if(!context||!visit||!date||!value('code')||!Number.isInteger(Number(value('units'))))return null;return new URLSearchParams({visit_id:visit,service_date:date,...context,code_system:value('code_system'),code:value('code').trim().toUpperCase(),modifiers:value('modifiers')||'',units:value('units')}).toString();}
function feePlaceMemoryRead(){try{const raw=localStorage.getItem('suncharts.charge.place'),parsed=raw?JSON.parse(raw):null;if(!parsed||typeof parsed!=='object')return null;return {facility_id:String(parsed.facility_id||''),setting:String(parsed.setting||'')};}catch{return null;}}
function feePlaceRemember(form){const context=feeContextValue(form);if(context)try{localStorage.setItem('suncharts.charge.place',JSON.stringify(context));}catch{/* The choice is only a convenience. */}}
function feePlaceFallback(facilities,saved){const remembered=feePlaceMemoryRead(),rememberedFacility=facilities.some(f=>f.id===remembered?.facility_id)?remembered.facility_id:'',rememberedSetting=['nonfacility','facility'].includes(remembered?.setting)?remembered.setting:'',only=facilities.length===1&&!saved?.facility_id?facilities[0].id:'';return {facility_id:saved?.facility_id||rememberedFacility||only,setting:saved?.setting||rememberedSetting||'nonfacility'};}
// Preselecting is equivalent to the staff member picking the choice, so the same
// change handling (and fee lookup) runs after the list loads or a choice is made.
function feeContextChanged(form,target){feePlaceRemember(form);const rows=form.querySelectorAll?form.querySelectorAll('.billing-charge-row'):[];if(target&&['fee_facility','fee_setting'].includes(target.name)){for(const row of rows)void checkFee(form,row,false);return;}for(const row of rows)if(!row.querySelector('[name="amount"]').value)void checkFee(form,row,false);}
async function loadFeeContext(form,preserve=true){const host=form?.querySelector('[data-fee-context]');if(!host)return;const identity=me,patient=selected,visit=form.elements.visit_id?.value,date=form.elements.service_date?.value,generation=(feeRequests.get(host)||0)+1;feeRequests.set(host,generation);if(!visit||!date){host.querySelector('[data-fee-context-status]').textContent='Select an encounter and service date to check approved fees.';return;}
 const initialFacility=host.querySelector('[name="fee_facility"]').value,initialSetting=host.querySelector('[name="fee_setting"]').value,before=feeContextValue(form),saved=preserve?{facility_id:before?.facility_id||host.dataset.savedFacility,setting:before?.setting||host.dataset.savedSetting}:null;
 try{const data=await api(`/api/v1/patients/${patient}/fee-context?${new URLSearchParams({visit_id:visit,service_date:date})}`);if(!feeFormCurrent(form,identity,patient)||feeRequests.get(host)!==generation||form.elements.visit_id.value!==visit||form.elements.service_date.value!==date)return;
 const facility=host.querySelector('[name="fee_facility"]'),currentFacility=facility.value,currentSetting=host.querySelector('[name="fee_setting"]').value;facility.innerHTML='<option value="">Choose facility</option>'+data.facilities.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');if(saved?.facility_id&&!data.facilities.some(f=>f.id===saved.facility_id))facility.insertAdjacentHTML('beforeend',`<option value="${esc(saved.facility_id)}">Saved facility (no longer active)</option>`);const fallback=currentFacility!==initialFacility||currentSetting!==initialSetting?null:feePlaceFallback(data.facilities,saved);facility.value=currentFacility!==initialFacility?currentFacility:saved?.facility_id||data.facility_id||fallback?.facility_id||'';host.querySelector('[name="fee_setting"]').value=currentSetting!==initialSetting?currentSetting:saved?.setting||data.setting||fallback?.setting||'';host.querySelector('[data-fee-context-status]').textContent=data.reason;if(fallback)feeContextChanged(form,null);else if(typeof chargeProposePriceRows==='function')chargeProposePriceRows(form);for(const row of form.querySelectorAll('.billing-charge-row'))if(!fallback&&!row.querySelector('[name="amount"]').value)void checkFee(form,row,false);
 }catch(e){if(feeFormCurrent(form,identity,patient)&&feeRequests.get(host)===generation)host.querySelector('[data-fee-context-status]').textContent='Fee lookup unavailable. Existing amounts are retained; reviewed manual charges remain available.';}
}
// The practice's place of service for this encounter, as its fee details would answer it. The
// charges table filled in from an earlier visit asks for prices as its rows appear, before the
// fee details box has drawn itself; the same choice is made here so nothing waits on the order.
async function feeContextQuick(form){
 const visit=form.elements.visit_id?.value,date=form.elements.service_date?.value;if(!visit||!date)return null;
 const identity=me,patient=selected;
 try{
  const data=await api(`/api/v1/patients/${patient}/fee-context?${new URLSearchParams({visit_id:visit,service_date:date})}`);
  if(!feeFormCurrent(form,identity,patient)||form.elements.visit_id.value!==visit||form.elements.service_date.value!==date)return null;
  const facility_id=data.facility_id||feePlaceFallback(data.facilities||[],null).facility_id,setting=data.setting||feePlaceFallback(data.facilities||[],null).setting;
  return facility_id&&setting?{facility_id,setting}:null;
 }catch{return null;}
}
function feeOverrideState(row){const host=row.querySelector('[data-fee-line]');if(!host)return;const amount=row.querySelector('[name="amount"]').value;let differs=false;try{differs=host.dataset.feeSchedule&&cents(amount)!==Number(host.dataset.feeExpected);}catch{differs=!!host.dataset.feeSchedule;}const label=host.querySelector('[data-fee-override]');label.hidden=!differs&&!label.querySelector('input').value;label.querySelector('input').required=!!differs;}
function applyFee(form,row,quote){const host=row.querySelector('[data-fee-line]');row.querySelector('[name="amount"]').value=dollars(quote.expected_line_amount_cents);host.dataset.feeSchedule=quote.schedule_id;host.dataset.feeEntry=quote.entry_key;host.dataset.feeExpected=String(quote.expected_line_amount_cents);host.dataset.feeQuery=feeQuery(form,row);delete host.dataset.feePreserved;host.querySelector('[data-fee-manual]').hidden=false;host.querySelector('[name="fee_override_reason"]').value='';feeOverrideState(row);captureBillingChargeDraft();}
// The price list has nothing for this line. Nothing is guessed: the amount stays as it is and
// the fee note says what the lookup could not do, which is what the table filled in from an
// earlier visit reads as "this one still needs an amount".
// Both outcomes of a price lookup — covered or not — say the same thing to a filled-in row, so
// the note is asked for in one place and the row's note is never left behind the price list.
function feeRowPriced(form,row){if(typeof chargePricedByFeeLookup==='function')chargePricedByFeeLookup(form,row);}
async function checkFee(form,row,apply=false,context){const host=row.querySelector('[data-fee-line]'),query=feeQuery(form,row,context);if(!host)return;const unpriced=()=>{if(!query)host.querySelector('[data-fee-status]').textContent='Type the amount for this line.';if(apply)feeRowPriced(form,row);};if(!query){unpriced();return;}const initialAmount=row.querySelector('[name="amount"]').value,identity=me,patient=selected,generation=(feeRequests.get(host)||0)+1;feeRequests.set(host,generation);host.querySelector('[data-fee-apply]').hidden=true;
 try{const data=await api(`/api/v1/patients/${patient}/fee-quote?${query}`);if(!feeFormCurrent(form,identity,patient)||!row.isConnected||feeRequests.get(host)!==generation||feeQuery(form,row)!==query)return;const q=data.quote;if(!q){host.querySelector('[data-fee-status]').textContent=data.reason;if(apply)feeRowPriced(form,row);return;}host.feeQuote=q;host.dataset.quoteQuery=query;host.querySelector('[data-fee-status]').textContent=`Approved ${q.schedule.name}: ${money(q.unit_amount_cents)} per unit × ${q.units} = ${money(q.expected_line_amount_cents)}. ${q.schedule.qp_basis}; ${q.schedule.locality}.`;host.querySelector('[data-fee-apply]').hidden=false;
 const amount=row.querySelector('[name="amount"]').value;let ownedAmount=false;try{ownedAmount=!!host.dataset.feeSchedule&&cents(amount)===Number(host.dataset.feeExpected);}catch{}if((apply&&amount===initialAmount)||(!host.dataset.feePreserved&&(!amount||ownedAmount)))applyFee(form,row,q);
 }catch(e){if(feeFormCurrent(form,identity,patient)&&row.isConnected&&feeRequests.get(host)===generation)host.querySelector('[data-fee-status]').textContent='No saved price for this code yet. Type the amount.';}
}
function feeInputsChanged(form,row,field){const host=row?.querySelector('[data-fee-line]');if(!host)return;if(field==='amount'){host.dataset.feePreserved='true';feeOverrideState(row);if(typeof chargeRowsPriced==='function')chargeRowsPriced(form);return;}host.querySelector('[data-fee-apply]').hidden=true;host.feeQuote=null;void checkFee(form,row,false);}
document.addEventListener('change',e=>{const form=e.target.closest?.('#billing-account-form');if(!form)return;const name=e.target.name;if(['visit_id','service_date'].includes(name)){void loadFeeContext(form,false);return;}if(['fee_facility','fee_setting'].includes(name)){feeContextChanged(form,e.target);return;}if(['code','code_system','modifiers','units','amount'].includes(name))feeInputsChanged(form,e.target.closest('.billing-charge-row'),name);});
document.addEventListener('input',e=>{const row=e.target.closest?.('.billing-charge-row');if(row&&e.target.name==='amount'){row.querySelector('[data-fee-line]').dataset.feePreserved='true';feeOverrideState(row);}else if(row&&['code','code_system','modifiers','units'].includes(e.target.name)){clearTimeout(feeTimers.get(row));const form=row.closest('#billing-account-form'),identity=me,patient=selected;feeTimers.set(row,setTimeout(()=>{if(feeFormCurrent(form,identity,patient)&&row.isConnected)void checkFee(form,row,false);},250));}});
document.addEventListener('click',e=>{const button=e.target.closest?.('button');if(!button)return;if(button.hasAttribute('data-fees-manage')){e.preventDefault();run(showFeeAdmin);return;}const form=button.closest('#billing-account-form'),row=button.closest('.billing-charge-row');if(form&&row&&button.hasAttribute('data-fee-manual')){e.preventDefault();const host=row.querySelector('[data-fee-line]');feeRequests.set(host,(feeRequests.get(host)||0)+1);host.dataset.feeSchedule='';host.dataset.feeEntry='';host.dataset.feeExpected='';host.dataset.feePreserved='true';host.querySelector('[data-fee-manual]').hidden=true;host.querySelector('[name="fee_override_reason"]').value='';host.querySelector('[data-fee-status]').textContent='Manual pricing selected. Enter a reviewed line total and record the reason when saving charges.';host.querySelector('[data-fee-apply]').hidden=true;feeOverrideState(row);captureBillingChargeDraft();return;}if(form&&row&&button.hasAttribute('data-fee-check')){e.preventDefault();void checkFee(form,row,false);}if(form&&row&&button.hasAttribute('data-fee-apply')){e.preventDefault();const host=row.querySelector('[data-fee-line]');if(host.feeQuote&&host.dataset.quoteQuery===feeQuery(form,row))applyFee(form,row,host.feeQuote);else void checkFee(form,row,true);}});
async function showFeeAdmin(){if(me?.role!=='owner')throw new Error('Practice owner access is required.');const identity=me;showTool('Practice fees');$('tools').innerHTML='<p data-fees-loading>Loading practice fee proposals…</p>';const loading=$('tools').querySelector('[data-fees-loading]');const [schedules,providers,facilities]=await Promise.all([api('/api/v1/practice/fee-schedules'),api('/api/v1/practice/providers'),api('/api/v1/practice/facilities')]);if(me!==identity||!loading?.isConnected||$('tools').hidden)return;feeAdminState={identity,schedules:schedules.items,providers:providers.items.filter(x=>x.active),facilities:facilities.items.filter(x=>x.active),proposal:null};renderFeeAdmin();}
function feeTodayISO(){const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;}
function feeDefaultEndISO(){return `${new Date().getFullYear()+2}-12-31`;}
function renderFeeAdmin(){const s=feeAdminState;if(!s||s.identity!==me)return;$('tools').innerHTML=`<section id="fee-admin" class="panel"><h2>Practice fees</h2><p>Prepare a proposal, review its source and scope, then approve it explicitly. Draft and retired schedules never supply new fees. Approval affects new charge entry; saved charges and patient balances remain unchanged.</p><button type="button" data-fees-manage>Refresh schedules</button><div>${s.schedules.map(r=>`<article class="integration-access-row"><div><strong>${esc(r.content.name)}</strong><p>${esc(r.status)} · ${r.entry_count} entries · ${esc(r.content.setting)} · ${esc(r.content.qp_basis)} · ${esc(r.content.effective_from)} through ${esc(r.content.effective_to)}</p></div><button type="button" data-fee-review="${esc(r.id)}">Review schedule</button></article>`).join('')||'<p>No practice fee schedules have been created.</p>'}</div><hr><h3>Enter your own prices</h3><form id="fee-practice-form"><div class="form-grid"><label>Provider<select name="provider_id" required><option value="">Choose provider</option>${s.providers.map(p=>`<option value="${esc(p.id)}">${esc(p.display_name)}</option>`).join('')}</select></label><label>Facility<select name="facility_id" required><option value="">Choose facility</option>${s.facilities.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></label><label>Place of service<select name="place" required><option value="nonfacility">Office</option><option value="facility">Facility</option></select></label><label>Starts<input name="starts" type="date" required value="${esc(feeTodayISO())}"></label><label>Ends<input name="ends" type="date" required value="${esc(feeDefaultEndISO())}"></label><label>Name<input name="name" maxlength="200" required value="Practice prices"></label></div><label>Prices, one per line<textarea name="prices" rows="10" spellcheck="false"></textarea></label><p class="muted">Code, then the price. Add a modifier after the code if it changes the price. Example: 99214 169.81 or 99213 25 110.00</p><p data-fee-prices-status class="muted" role="status"></p><button type="submit">Save as draft</button><p class="muted">Prices take effect after you approve the draft below.</p></form><hr><h3>Prepare a reference proposal</h3><p>Choose a locally prepared SunCharts Medicare reference JSON file. No source file is uploaded until you save a draft. Codes with unavailable settings or special source qualifications are excluded from this standard proposal.</p><input type="file" accept="application/json,.json" data-fee-file><p data-fee-file-status></p><form id="fee-proposal-form"><div class="form-grid"><label>Schedule name<input name="name" maxlength="200" required></label><label>Provider<select name="provider_id" required><option value="">Choose provider</option>${s.providers.map(p=>`<option value="${esc(p.id)}">${esc(p.display_name)}</option>`).join('')}</select></label><label>Facility<select name="facility_id" required><option value="">Choose facility</option>${s.facilities.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></label><label>Verified clinician QP basis<select name="qp_basis" required><option value="">Choose verified basis</option><option value="non_qp">Non-QP</option><option value="qp">QP</option></select></label><label>Service setting<select name="setting" required><option value="">Choose service setting</option><option value="nonfacility">Non-facility / office</option><option value="facility">Facility</option></select></label><label>Practice charge multiplier (%)<input name="percent" type="number" min="0.01" max="1000" step="0.01" required placeholder="Explicit practice policy, e.g. 100"></label><label>Effective from<input name="effective_from" type="date" required></label><label>Effective through<input name="effective_to" type="date" required></label></div><label class="review-ack"><input name="default_for_scope" type="checkbox"> Use this setting as the automatic default for this provider and facility during these dates</label><label>Optional selected codes (comma separated; blank includes all eligible standard reference codes)<input name="codes" maxlength="10000"></label><label>Proposal reason<input name="reason" maxlength="1000" required></label><button type="submit">Save inactive draft proposal</button></form><div id="fee-review"></div></section>`;}
function prepareFeeProposal(source,data){if(source?.format!=='suncharts.physician-fee-reference-proposal.v1'||source.activated||!Array.isArray(source.reference_rows)||!Array.isArray(source.sources))throw new Error('Choose an inactive SunCharts physician fee reference proposal.');const basis=data.qp_basis==='qp'?'QP':data.qp_basis==='non_qp'?'nonQP':null;if(!basis||!['facility','nonfacility'].includes(data.setting))throw new Error('Select the verified QP basis and service setting.');const percent=String(data.percent);if(!/^\d+(\.\d{1,2})?$/.test(percent))throw new Error('Enter an explicit percentage with at most two decimals.');const multiplier=Math.round(Number(percent)*100),codes=new Set((data.codes||'').toUpperCase().split(',').map(x=>x.trim()).filter(Boolean));const entries=source.reference_rows.filter(r=>!codes.size||codes.has(r.code)).flatMap(r=>{const v=r[basis],amount=v?.['standalone_'+data.setting+'_reference_cents'];if(!Number.isSafeInteger(amount)||amount<=0||v[data.setting+'_candidate_requires_special_review'])return [];return [{code_system:r.code_system,code:r.code,modifiers:r.source_modifier||'',reference_unit_cents:amount,source_id:v.source_id,source_row:v.source_row,qualification:`CMS status ${v.status}; current RVU ${v.current_rvu_status} (${v.current_rvu_member||'reference file'} row ${v.current_rvu_row||'not provided'}); OPPS indicator ${v.opps_indicator}; published ${v[data.setting+'_cents']} cents; reference amount includes applicable lower published OPPS cap. Owner reviews service coverage and modifier scope separately.`}];});if(!entries.length)throw new Error('No eligible standard reference rows match this scope. Missing or specially qualified services require separate review.');return {name:data.name,provider_id:data.provider_id,facility_id:data.facility_id,setting:data.setting,qp_basis:data.qp_basis,locality:`${source.locality.carrier}/${source.locality.locality} ${source.locality.name}`,reference_from:source.reference_quarter_start,reference_to:source.reference_quarter_end,effective_from:data.effective_from,effective_to:data.effective_to,multiplier_basis_points:multiplier,default_for_scope:data.default_for_scope==='on',sources:[...source.sources.filter(x=>x.basis===basis).map(x=>({id:x.id,url:x.download_url,sha256:x.archive_sha256,published_on:x.publication_date})),...(source.current_rvu_validation?.publication_date?[{id:'current-rvu-validation',url:source.current_rvu_validation.source_url,sha256:source.current_rvu_validation.archive_sha256,published_on:source.current_rvu_validation.publication_date}]:[]),...(source.locality.crosswalk_publication_date?[{id:'zip-locality-crosswalk',url:source.locality.crosswalk_source_url,sha256:source.locality.crosswalk_archive_sha256,published_on:source.locality.crosswalk_publication_date}]:[])],entries};}
document.addEventListener('change',e=>{if(!e.target.matches?.('[data-fee-file]'))return;const s=feeAdminState,file=e.target.files?.[0];if(!s||s.identity!==me||!file)return;const generation=(s.fileGeneration||0)+1;s.fileGeneration=generation;s.proposal=null;if(file.size>32*1024*1024){notice('Reference proposal exceeds the 32 MiB local limit.',true);return;}void file.text().then(text=>{if(s!==feeAdminState||s.identity!==me||s.fileGeneration!==generation)return;const source=JSON.parse(text);if(source.format!=='suncharts.physician-fee-reference-proposal.v1')throw new Error('Unsupported reference proposal.');s.proposal=source;const status=$('fee-admin')?.querySelector('[data-fee-file-status]');if(status)status.textContent=`${source.reference_rows.length} reference keys loaded locally; nothing has been uploaded or approved.`;}).catch(e=>notice(e.message,true));});
function parsePracticePrices(text){const entries=[],seen=new Map();const lines=String(text??'').split(/\r?\n/);for(let index=0;index<lines.length;index+=1){const line=lines[index].trim();if(!line)continue;const parts=line.split(/[\s,]+/).filter(Boolean);const code=(parts[0]||'').toUpperCase();const price=(parts.at(-1)||'').replace(/^\$/,'');if(parts.length<2||!/^[0-9]{4}[0-9A-TV-Z]$|^[A-Z][0-9]{3}[A-Z0-9]$/.test(code)||!/^\d+(\.\d{1,2})?$/.test(price))throw new Error(`Line ${index+1} is not a code and a price.`);const mods=parts.slice(1,-1);if(mods.length>4||mods.some(m=>m.length!==2||!/^[0-9A-Z]{2}$/.test(m)))throw new Error(`Line ${index+1} is not a code and a price.`);const modifiers=mods.map(m=>m.toUpperCase()).join(','),cents=Math.round(Number(price)*100);if(cents<1)throw new Error(`Line ${index+1} is not a code and a price.`);const key=`${code}:${modifiers}`;if(seen.has(key))throw new Error(`Line ${index+1} repeats the price already given on line ${seen.get(key)}.`);seen.set(key,index+1);entries.push({code_system:/^[0-9]{4}[0-9A-Z]$/.test(code)?'CPT':'HCPCS',code,modifiers,reference_unit_cents:cents,source_id:'practice',source_row:index+1,qualification:'Practice price'});}if(!entries.length)throw new Error('Enter at least one line with a code and a price.');return entries;}
function preparePracticeProposal(data,entries){if(!Array.isArray(entries)||!entries.length)throw new Error('Enter at least one line with a code and a price.');if(!data.provider_id||!data.facility_id||!['facility','nonfacility'].includes(data.setting)||!data.effective_from||!data.effective_to)throw new Error('Choose the provider, facility, place of service and dates.');if(data.effective_to<data.effective_from)throw new Error('The end date is before the start date.');if(!data.name?.trim())throw new Error('Enter a name for these prices.');return {name:data.name.trim(),provider_id:data.provider_id,facility_id:data.facility_id,setting:data.setting,qp_basis:'not_applicable',locality:'Practice',reference_from:data.effective_from,reference_to:data.effective_to,effective_from:data.effective_from,effective_to:data.effective_to,multiplier_basis_points:10000,default_for_scope:true,sources:[{id:'practice',kind:'practice_entered',entered_by_note:'Entered by the practice'}],entries};}
document.addEventListener('submit',e=>{if(e.target.id!=='fee-proposal-form')return;e.preventDefault();const form=e.target,s=feeAdminState;if(!s||s.identity!==me)return;run(async()=>{const data=Object.fromEntries(new FormData(form)),content=prepareFeeProposal(s.proposal,data);form.dataset.request||=crypto.randomUUID();await api('/api/v1/practice/fee-schedules','POST',{request_id:form.dataset.request,content,reason:data.reason});if(s.identity===me&&form.isConnected&&!$('tools').hidden){await showFeeAdmin();notice('Inactive fee proposal saved. Review and approval are still required.');}});});
document.addEventListener('submit',e=>{if(e.target.id!=='fee-practice-form')return;e.preventDefault();const form=e.target,s=feeAdminState;if(!s||s.identity!==me)return;const status=form.querySelector('[data-fee-prices-status]'),data=Object.fromEntries(new FormData(form));let entries;try{entries=parsePracticePrices(data.prices);}catch(err){if(status)status.textContent=err.message;return;}if(status)status.textContent='';const content=preparePracticeProposal({name:data.name,provider_id:data.provider_id,facility_id:data.facility_id,setting:data.place,effective_from:data.starts,effective_to:data.ends},entries);run(async()=>{form.dataset.request||=crypto.randomUUID();await api('/api/v1/practice/fee-schedules','POST',{request_id:form.dataset.request,content,reason:'Prices entered by the practice'});if(s.identity===me&&form.isConnected&&!$('tools').hidden){await showFeeAdmin();notice('Draft saved. Approve it below before prices are used.');}});});
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-fee-review]');if(!b)return;e.preventDefault();const identity=me;run(async()=>{const r=await api(`/api/v1/practice/fee-schedules/${b.dataset.feeReview}`);if(me!==identity||!$('fee-review'))return;const c=r.content;feeAdminState.review=r;$('fee-review').innerHTML=`<h3>${esc(c.name)} · ${esc(r.status)}</h3><p>${esc(c.directory_snapshot.provider.name)} · ${esc(c.directory_snapshot.facility.name)} · ${esc(c.locality)} · ${esc(c.qp_basis)} · ${esc(c.setting)}</p><p>Reference ${esc(c.reference_from)} through ${esc(c.reference_to)}; practice dates ${esc(c.effective_from)} through ${esc(c.effective_to)}; ${c.multiplier_basis_points/100}% of reference. ${c.entries.length} exact code/modifier entries.</p><p>Automatic context default: ${c.default_for_scope?'Explicitly selected for this scope':'Not selected'}.</p><details><summary>Source evidence</summary>${c.sources.map(source=>source.kind==='practice_entered'?`<p>${esc(source.id)} · prices entered by the practice<br><small>${esc(source.entered_by_note||'')}</small></p>`:`<p><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.id)}</a> · published ${esc(source.published_on)}<br><small>SHA-256 ${esc(source.sha256)}</small></p>`).join('')}</details><label>Find a fee by code or modifier<input type="search" data-fee-entry-search placeholder="Code or modifier"></label><div data-fee-entry-table></div>${r.status!=='retired'?`<form id="fee-action-form" data-id="${esc(r.id)}" data-version="${r.version}"><label>Reason<input name="reason" maxlength="1000" required></label>${r.status==='draft'?'<label class="review-ack"><input name="reviewed_scope_and_sources" type="checkbox" required> I reviewed provider QP eligibility, service facility and setting, locality, dates, exact modifiers, source evidence and practice charge policy.</label><button type="submit" name="action" value="approve">Approve this fee schedule</button>':''}<button type="submit" name="action" value="retire" formnovalidate>Retire proposal / schedule</button></form>`:''}`;feeAdminState.reviewPage=0;renderFeeReviewEntries();});});
document.addEventListener('submit',e=>{if(e.target.id!=='fee-action-form')return;e.preventDefault();const form=e.target,identity=me,action=e.submitter?.value;run(async()=>{const data=Object.fromEntries(new FormData(form));if(!data.reason?.trim())throw new Error('A reason is required.');await api(`/api/v1/practice/fee-schedules/${form.dataset.id}/actions`,'POST',{action,reason:data.reason,reviewed_scope_and_sources:data.reviewed_scope_and_sources==='on'},Number(form.dataset.version));if(me===identity&&form.isConnected&&!$('tools').hidden){await showFeeAdmin();notice(action==='approve'?'Fee schedule approved for new charge entry. Existing charges are unchanged.':'Fee schedule retired; existing charge evidence is preserved.');}});});

function renderFeeReviewEntries(){const r=feeAdminState?.review,host=$('fee-review')?.querySelector('[data-fee-entry-table]');if(!r||!host||feeAdminState.identity!==me)return;const query=$('fee-review').querySelector('[data-fee-entry-search]').value.trim().toUpperCase(),rows=r.content.entries.filter(e=>!query||e.code.includes(query)||e.modifiers.toUpperCase().includes(query)),page=Math.min(feeAdminState.reviewPage||0,Math.max(0,Math.ceil(rows.length/100)-1));feeAdminState.reviewPage=page;host.innerHTML=`<p>${rows.length} matching exact fees · ${rows.length?page*100+1:0}–${Math.min((page+1)*100,rows.length)}</p><div class="billing-table-wrap"><table class="billing-table"><thead><tr><th>Code / modifiers</th><th>Source unit amount</th><th>Practice unit fee</th><th>Source qualification</th></tr></thead><tbody>${rows.slice(page*100,(page+1)*100).map(e=>`<tr><td>${esc(e.code_system)} ${esc(e.code)} / ${esc(e.modifiers||'blank')}</td><td>${money(e.reference_unit_cents)}</td><td>${money(Math.floor((e.reference_unit_cents*r.content.multiplier_basis_points+5000)/10000))}</td><td>${esc(e.source_id)} · row ${e.source_row}<small>${esc(e.qualification)}</small></td></tr>`).join('')||'<tr><td colspan="4">No matching fee entries.</td></tr>'}</tbody></table></div><div class="actions"><button type="button" data-fee-entry-page="-1" ${page===0?'disabled':''}>Previous fees</button><button type="button" data-fee-entry-page="1" ${(page+1)*100>=rows.length?'disabled':''}>Next fees</button></div>`;}
document.addEventListener('input',e=>{if(e.target.matches?.('[data-fee-entry-search]')){feeAdminState.reviewPage=0;renderFeeReviewEntries();}});
document.addEventListener('click',e=>{const b=e.target.closest?.('[data-fee-entry-page]');if(b&&feeAdminState?.identity===me){e.preventDefault();feeAdminState.reviewPage+=Number(b.dataset.feeEntryPage);renderFeeReviewEntries();}});

// A price typed on a charge line can be kept for next time. It goes on the practice's own code list
// (Codes & prices), so the next time the code is picked its name and price fill in by themselves.
const priceMemoryTimers=new WeakMap();
function priceMemoryNode(row){const host=row?.querySelector?.('[data-fee-line]');if(!host||typeof document.createElement!=='function')return null;let node=host.querySelector('[data-price-memory]');if(!node){node=document.createElement('p');node.className='charge-price-memory muted';node.dataset.priceMemory='';host.append(node);}return node;}
function priceMemoryFacts(row){
 const code=(row.querySelector('[name="code"]')?.value||'').trim().toUpperCase(),units=Math.max(1,Math.trunc(Number(row.querySelector('[name="units"]')?.value)||1));
 let total=null;try{const raw=(row.querySelector('[name="amount"]')?.value||'').trim();total=raw?cents(raw):null;}catch{}
 const system=/^[0-9]{4}[0-9A-TV-Z]$/.test(code)?'CPT':/^[A-Z][0-9]{4}$/.test(code)?'HCPCS':'';
 return {code,system,unit:total!=null&&total>0&&total%units===0?total/units:null,display:(row.querySelector('[name="description"]')?.value||'').trim()};
}
async function priceMemoryCheck(row){
 const node=priceMemoryNode(row);if(!node)return;
 const facts=priceMemoryFacts(row),input=row.querySelector('[name="amount"]'),units=Math.max(1,Math.trunc(Number(row.querySelector('[name="units"]')?.value)||1));node.priceMemory=null;
 if(!facts.system){node.replaceChildren();return;}
 let known=null;
 try{const data=await api(`/api/v1/practice/codes?${new URLSearchParams({system:facts.system,q:facts.code})}`);known=(data.items||[]).find(item=>item.code===facts.code)||null;}catch{node.replaceChildren();return;}
 if(!row.isConnected||priceMemoryFacts(row).code!==facts.code)return;
 const price=known?.price_cents??null,typed=(input?.value||'').trim();
 // A code the practice already keeps brings its name with it when the line has none.
 const describe=row.querySelector('[name="description"]');
 if(known?.display&&describe&&!describe.value.trim()&&!describe.readOnly&&!describe.disabled){describe.value=known.display;describe.dispatchEvent(new Event('input',{bubbles:true}));describe.dispatchEvent(new Event('change',{bubbles:true}));}
 // The practice price fills an empty amount by itself; nobody presses anything.
 if(price!=null&&!typed&&input&&!input.readOnly&&!input.disabled){
  input.value=dollars(price*units);
  input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
  node.textContent=`Practice price ${money(price)}${units>1?` × ${units}`:''}.`;return;
 }
 const now=priceMemoryFacts(row);
 if(price!=null){node.textContent=now.unit===price?`Practice price ${money(price)}${units>1?` × ${units}`:''}.`:`Changed for this encounter. The practice price is ${money(price)}${units>1?' per unit':''}.`;return;}
 if(!typed){node.textContent=`No practice price for ${facts.code} yet. Type the amount: keep it for this encounter only, or save it as the practice price.`;return;}
 node.replaceChildren('One-time amount for this encounter. ');
 if(!(typeof billingCan==='function'?billingCan('edit'):me?.role==='owner')||now.unit==null)return;
 const button=document.createElement('button');button.type='button';button.className='text-button';button.dataset.priceMemorySave='';
 button.textContent=`Save ${money(now.unit)} as the practice price for ${facts.code}`;
 node.append(button);node.priceMemory={facts:now,known};
}
function priceMemorySchedule(row){if(!row)return;clearTimeout(priceMemoryTimers.get(row));priceMemoryTimers.set(row,setTimeout(()=>{if(row.isConnected)void priceMemoryCheck(row);},500));}
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('change',event=>{const row=event.target?.closest?.('.billing-charge-row');if(row&&['code','units','amount','description'].includes(event.target.name))priceMemorySchedule(row);});
 document.addEventListener('input',event=>{const row=event.target?.closest?.('.billing-charge-row');if(row&&['code','amount','units'].includes(event.target.name))priceMemorySchedule(row);});
 document.addEventListener('focusin',event=>{const row=event.target?.closest?.('.billing-charge-row');if(row&&!row.dataset.priceMemorySeen){row.dataset.priceMemorySeen='1';priceMemorySchedule(row);}});
 document.addEventListener('click',event=>{
  const button=event.target?.closest?.('[data-price-memory-save]');if(!button?.hasAttribute?.('data-price-memory-save'))return;
  event.preventDefault();const node=button.closest('[data-price-memory]'),memory=node?.priceMemory;if(!memory)return;
  const {facts,known}=memory;
  run(async()=>{
   if(!known&&!facts.display)throw new Error('Add what this service was first, so the code is saved with its name.');
   if(known)await api(`/api/v1/practice/codes/${encodeURIComponent(known.id)}`,'PUT',{display:known.display,enabled:true,price_cents:facts.unit,default_units:known.default_units||1,modifiers:known.modifiers||''},known.version);
   else await api('/api/v1/practice/codes','POST',{request_id:crypto.randomUUID(),system:facts.system,code:facts.code,display:facts.display,enabled:true,price_cents:facts.unit,default_units:1,modifiers:''});
   node.priceMemory=null;node.textContent=`Saved. ${facts.code} now fills in ${money(facts.unit)} by itself.`;
  });
 });
}
// Money and counts take numbers only: an amount is digits with at most one point and two places,
// units are whole numbers. Anything else is dropped as it is typed, before the line reads it.
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('input',event=>{
 const field=event.target;if(!field?.closest?.('.billing-charge-row'))return;
 if(field.name==='amount'){
  const [whole,...rest]=String(field.value).replace(/[^0-9.]/g,'').split('.');
  const clean=rest.length?`${whole}.${rest.join('').slice(0,2)}`:whole;
  if(clean!==field.value)field.value=clean;
  if(field.setAttribute&&field.getAttribute?.('inputmode')!=='decimal')field.setAttribute('inputmode','decimal');
 }else if(field.name==='units'&&field.type!=='number'){
  const clean=String(field.value).replace(/[^0-9]/g,'');if(clean!==field.value)field.value=clean;
 }
},true);

// Bundles: a practice's named sets of procedure lines. One pick adds every line of the set to the
// encounter with its modifiers, units and drug details; each line is then priced from the practice's
// own code list and pointed at the encounter's diagnoses, exactly like a line added by hand.
let chargeBundles=null,chargeBundlesLoading=null;
function chargeBundlesLoad(force=false){
 if(chargeBundles&&!force)return Promise.resolve(chargeBundles);
 if(!chargeBundlesLoading)chargeBundlesLoading=api('/api/v1/practice/charge-bundles').then(data=>{chargeBundles=data.items||[];}).catch(()=>{chargeBundles=chargeBundles||[];}).finally(()=>{chargeBundlesLoading=null;});
 return chargeBundlesLoading;
}
function chargeBundleSummary(bundle){return (bundle.lines||[]).map(line=>`${line.code}${line.modifiers?'-'+String(line.modifiers).replace(/\s+/g,'-'):''}${line.units>1?` × ${line.units}`:''}`).join(', ');}
function chargeBundlesPaint(){
 const form=typeof $==='function'?$('billing-account-form'):null,host=form?.querySelector?.('[data-charge-bundles]');if(!host)return;
 const can=typeof billingCan==='function'&&billingCan('edit')&&!form.dataset.draftReadOnly,items=chargeBundles||[];
 host.innerHTML=`<span class="charge-bundles-label">Bundles</span>${items.map(bundle=>`<button type="button" data-bundle-add="${esc(bundle.id)}" title="${esc(chargeBundleSummary(bundle))}">+ ${esc(bundle.name)}</button>`).join('')||'<span class="muted">None yet. Enter your usual lines once, then save them as a bundle.</span>'}${can?'<button type="button" class="text-button" data-bundle-save>Save these lines as a bundle</button>':''}${can&&items.length?'<button type="button" class="text-button" data-bundle-manage>Manage bundles</button>':''}`;
}
function chargeBundleApply(bundle){
 const form=$('billing-account-form'),body=form?.querySelector('#billing-charge-lines tbody');if(!body||form.dataset.draftReadOnly||form.dataset.draftStale)return;
 // A row nobody has typed in makes way for the bundle.
 for(const row of chargeLiveRows(form)){const blank=!(row.querySelector('[name="code"]')?.value||'').trim()&&!chargeLineDescription(row).trim()&&chargeRowAmount(row)==null;if(blank){chargeRowMemoryCache.delete(row);row.remove();}}
 const added=[];
 for(const line of bundle.lines||[]){
  body.insertAdjacentHTML('beforeend',chargeRow({code_system:line.code_system,code:line.code,description:line.description,modifiers:String(line.modifiers||'').split(/\s+/).filter(Boolean).join(','),units:line.units||1,diagnosis_codes:[],...(line.ndc_code?{ndc_code:line.ndc_code,ndc_quantity:line.ndc_quantity,ndc_unit:line.ndc_unit}:{})},form.dataset.compact==='true',chargeLineKey(null,chargeLiveRows(form).length)));
  const row=body.lastElementChild;row.dataset.diagnosesDefault='pending';chargeRowCapture(row);added.push(row);
 }
 chargeTableTotals(form);renderChargeRowProblems(form);
 for(const row of added){row.dataset.priceMemorySeen='1';void priceMemoryCheck(row);}
 captureBillingChargeDraft();scheduleChargeAutosave(form);
 added[0]?.scrollIntoView?.({block:'nearest'});
 if(typeof notice==='function')notice(`Added ${bundle.name}: ${added.length} line${added.length===1?'':'s'}.`);
}
function chargeBundleLinesFromTable(form){
 return chargeLiveRows(form).map(chargeRowValue).filter(line=>line.code&&String(line.description||'').trim()).map(line=>({code_system:line.code_system||(/^[A-Z]/.test(line.code)?'HCPCS':'CPT'),code:line.code,description:String(line.description).trim(),modifiers:String(line.modifiers||'').toUpperCase().split(/[\s,]+/).filter(Boolean).join(' '),units:Math.max(1,Math.trunc(Number(line.units)||1)),...(line.ndc_code&&line.ndc_quantity&&line.ndc_unit?{ndc_code:line.ndc_code,ndc_quantity:String(line.ndc_quantity),ndc_unit:line.ndc_unit}:{})}));
}
function chargeBundleSaveSheet(){
 const form=$('billing-account-form'),lines=chargeBundleLinesFromTable(form);
 if(!lines.length)throw new Error('Add at least one procedure with its code and name first.');
 const panel=document.createElement('form');panel.className='bundle-sheet';
 panel.innerHTML=`<p class="muted">These lines are saved as one bundle. Next time, one pick adds them all. Amounts are not kept: each line is priced from your practice prices when it is added.</p><ul class="bundle-lines">${lines.map(line=>`<li><b>${esc(line.code)}${line.modifiers?'-'+esc(line.modifiers.replace(/\s+/g,'-')):''}</b> ${esc(line.description)}${line.units>1?` × ${line.units}`:''}</li>`).join('')}</ul><label>Bundle name<input name="name" required maxlength="80" placeholder="For example: Neck injection visit"></label><p class="muted" data-bundle-status role="status"></p><div class="actions"><button type="submit" class="primary">Save bundle</button><button type="button" data-sheet-close>Cancel</button></div>`;
 const dialog=sheetOpen('Save as a bundle',panel);
 panel.addEventListener('submit',event=>{event.preventDefault();const name=panel.elements.name.value.trim();if(!name)return;
  run(async()=>{
   try{const saved=await api('/api/v1/practice/charge-bundles','POST',{name,lines});chargeBundles=[...(chargeBundles||[]).filter(item=>item.id!==saved.id),saved].sort((a,b)=>a.name.localeCompare(b.name));}
   catch(error){panel.querySelector('[data-bundle-status]').textContent=error.message||'The bundle could not be saved.';return;}
   sheetClose(dialog);chargeBundlesPaint();notice(`Saved the bundle ${name}.`);
  });});
 panel.elements.name.focus();
}
function chargeBundleManageSheet(){
 const panel=document.createElement('div');panel.className='bundle-sheet';
 const paint=()=>{panel.innerHTML=`${(chargeBundles||[]).map(bundle=>`<div class="bundle-row"><div><b>${esc(bundle.name)}</b><p class="muted">${esc(chargeBundleSummary(bundle))}</p></div><button type="button" data-bundle-remove="${esc(bundle.id)}">Remove</button></div>`).join('')||'<p class="muted">No bundles.</p>'}<div class="actions"><button type="button" data-sheet-close>Done</button></div>`;};
 paint();const dialog=sheetOpen('Bundles',panel);
 panel.addEventListener('click',event=>{const button=event.target.closest?.('[data-bundle-remove]');if(!button)return;const bundle=(chargeBundles||[]).find(item=>item.id===button.dataset.bundleRemove);if(!bundle)return;
  run(async()=>{await api(`/api/v1/practice/charge-bundles/${encodeURIComponent(bundle.id)}`,'PUT',{name:bundle.name,lines:bundle.lines,enabled:false},bundle.version);chargeBundles=chargeBundles.filter(item=>item.id!==bundle.id);paint();chargeBundlesPaint();});});
 return dialog;
}
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',event=>{
 const button=event.target?.closest?.('button');if(!button?.closest?.('[data-charge-bundles]'))return;
 if(button.dataset?.bundleAdd){event.preventDefault();const bundle=(chargeBundles||[]).find(item=>item.id===button.dataset.bundleAdd);if(bundle)run(async()=>chargeBundleApply(bundle));return;}
 if(button.hasAttribute?.('data-bundle-save')){event.preventDefault();run(async()=>chargeBundleSaveSheet());return;}
 if(button.hasAttribute?.('data-bundle-manage')){event.preventDefault();run(async()=>chargeBundleManageSheet());}
});

// Drug wastage. Medicare wants every single-dose drug line to say what happened to the rest of
// the vial: JZ on the line when nothing was discarded, or a second line with JW for the discarded
// amount. Staff type what was given and the vial size; the lines are written for them.
const drugVialStore='suncharts.drugVialSize.';
function drugWasteFacts(row){
 const box=row?.querySelector?.('[data-drug-waste]');if(!box)return null;
 // The vial size typed last time for this drug comes back by itself.
 const vialField=box.querySelector('[data-waste-vial]'),drug=(row.querySelector('[name="code"]')?.value||'').trim().toUpperCase();
 if(vialField&&!vialField.value&&drug){try{vialField.value=localStorage.getItem(drugVialStore+drug)||'';}catch{}}
 const given=Math.trunc(Number(box.querySelector('[data-waste-given]')?.value)||0),vial=Math.trunc(Number(box.querySelector('[data-waste-vial]')?.value)||0);
 if(given<1||vial<1)return {given,vial,ready:false};
 const vials=Math.ceil(given/vial),discarded=vials*vial-given;
 return {given,vial,vials,discarded,ready:true};
}
function drugWasteNote(row){
 const note=row?.querySelector?.('[data-drug-waste-note]'),facts=drugWasteFacts(row);if(!note||!facts)return;
 if(!facts.ready){note.textContent='Type the units given and the vial size. Nothing discarded adds JZ; anything discarded adds its own JW line.';return;}
 note.textContent=facts.discarded?`${facts.vials} vial${facts.vials===1?'':'s'} opened: ${facts.given} given, ${facts.discarded} discarded. This line becomes ${facts.given} units and a JW line is added for ${facts.discarded}.`:`${facts.vials} vial${facts.vials===1?'':'s'} opened, nothing discarded. This line becomes ${facts.given} units with JZ.`;
}
function drugWasteModifiers(row,drop,add){
 const input=row.querySelector('[name="modifiers"]');if(!input)return;
 const list=String(input.value||'').toUpperCase().split(/[,\s]+/).filter(m=>m&&!drop.includes(m));
 if(add&&!list.includes(add))list.push(add);
 input.value=list.join(',');
}
function drugWasteField(row,name,value){const field=row.querySelector(`[name="${name}"]`);if(!field)return;field.value=String(value);field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}
function drugWasteApply(row){
 const form=row.closest('#billing-account-form'),body=row.closest('tbody'),facts=drugWasteFacts(row);
 if(!form||!body||form.dataset.draftReadOnly||form.dataset.draftStale)return;
 const note=row.querySelector('[data-drug-waste-note]');
 if(!facts?.ready){if(note)note.textContent='Type the units given and the vial size first, as whole numbers.';return;}
 const code=(row.querySelector('[name="code"]')?.value||'').trim().toUpperCase();if(!code)return;
 try{localStorage.setItem(drugVialStore+code,String(facts.vial));}catch{}
 // What one unit costs on this line now, so both lines keep the same price per unit.
 const before=priceMemoryFacts(row).unit,line=chargeRowValue(row);
 const oldQuantity=Number(line.ndc_quantity),perUnit=oldQuantity>0&&Number(line.units)>0?oldQuantity/Number(line.units):null;
 const quantity=n=>perUnit==null?'':String(Math.round(perUnit*n*1000)/1000);
 drugWasteModifiers(row,['JW','JZ'],facts.discarded?'':'JZ');
 drugWasteField(row,'units',facts.given);
 if(before!=null)drugWasteField(row,'amount',dollars(before*facts.given));
 if(perUnit!=null)drugWasteField(row,'ndc_quantity',quantity(facts.given));
 drugWasteField(row,'modifiers',row.querySelector('[name="modifiers"]')?.value||'');
 // The discarded amount is its own line: one already there for this drug is updated, not doubled.
 const wasteRows=chargeLiveRows(form).filter(other=>other!==row&&(other.querySelector('[name="code"]')?.value||'').trim().toUpperCase()===code&&String(other.querySelector('[name="modifiers"]')?.value||'').toUpperCase().split(/[,\s]+/).includes('JW'));
 let waste=wasteRows[0]||null;
 if(!facts.discarded){for(const other of wasteRows){chargeRowMemoryCache.delete(other);other.remove();}}
 else if(waste){drugWasteField(waste,'units',facts.discarded);if(before!=null)drugWasteField(waste,'amount',dollars(before*facts.discarded));if(perUnit!=null)drugWasteField(waste,'ndc_quantity',quantity(facts.discarded));}
 else{
  const mods=String(row.querySelector('[name="modifiers"]')?.value||'').toUpperCase().split(/[,\s]+/).filter(Boolean).concat('JW').join(',');
  const drug=line.ndc_code&&perUnit!=null?{ndc_code:line.ndc_code,ndc_quantity:quantity(facts.discarded),ndc_unit:line.ndc_unit}:{};
  row.insertAdjacentHTML('afterend',chargeRow({code_system:line.code_system,code:line.code,description:line.description,modifiers:mods,units:facts.discarded,diagnosis_codes:line.diagnosis_codes||[],...(before!=null?{amount_cents:before*facts.discarded}:{}),...drug},form.dataset.compact==='true',chargeLineKey(null,chargeLiveRows(form).length)));
  waste=row.nextElementSibling;chargeRowCapture(waste);waste.dataset.priceMemorySeen='1';void priceMemoryCheck(waste);
 }
 chargeTableTotals(form);renderChargeRowProblems(form);captureBillingChargeDraft();scheduleChargeAutosave(form);
 if(note)note.textContent=facts.discarded?`Done. ${facts.given} units on this line, and a JW line for the ${facts.discarded} discarded.`:`Done. ${facts.given} units on this line with JZ: nothing was discarded.`;
}
if(typeof document!=='undefined'&&document.addEventListener){
 document.addEventListener('input',event=>{
  const field=event.target;if(!field?.hasAttribute?.('data-waste-given')&&!field?.hasAttribute?.('data-waste-vial'))return;
  const clean=String(field.value).replace(/[^0-9]/g,'');if(clean!==field.value)field.value=clean;
  drugWasteNote(field.closest('.billing-charge-row'));
 },true);
 // The vial size typed last time for this drug comes back by itself.
 document.addEventListener('focusin',event=>{
  const field=event.target;if(!field?.hasAttribute?.('data-waste-given')&&!field?.hasAttribute?.('data-waste-vial'))return;
  const row=field.closest('.billing-charge-row'),vial=row?.querySelector('[data-waste-vial]'),code=(row?.querySelector('[name="code"]')?.value||'').trim().toUpperCase();
  if(vial&&!vial.value&&code){try{vial.value=localStorage.getItem(drugVialStore+code)||'';}catch{}drugWasteNote(row);}
 });
 document.addEventListener('click',event=>{
  const button=event.target?.closest?.('[data-drug-waste-apply]');if(!button?.hasAttribute?.('data-drug-waste-apply'))return;
  event.preventDefault();drugWasteApply(button.closest('.billing-charge-row'));
 });
}
