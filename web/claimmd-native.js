// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
let claimMdConnectionState;
async function loadClaimMdConnection(){
 claimMdConnectionState=await api('/api/v1/billing/claimmd/status');
 return claimMdConnectionState;
}
function claimMdConnectionCard(state=claimMdConnectionState){
 if(!state?.configured)return '<section class="mapping-notice"><b>Claim.MD is not connected</b><p>A practice owner or authorized service partner can connect the clinic AccountKey. Manual clearinghouse workflows remain available.</p></section>';
 if(!state.connected)return '<section class="mapping-notice"><b>Claim.MD setup needs attention</b><p>The saved connection must pass authentication and be enabled before native workflows can transmit or retrieve data.</p></section>';
 const active=state.active||{};
 return `<section class="connection-summary" aria-label="Claim.MD connection"><div class="section-head"><div><h3>Claim.MD</h3><p><b>Connected</b> · ${esc(active.usage==='P'?'Production':'Test')}</p></div><span class="pill">Native integration</span></div><p class="muted">Eligibility, claims, status, remittance and follow-up actions stay attached to SunCharts patient, coverage, claim and ledger records.</p></section>`;
}
