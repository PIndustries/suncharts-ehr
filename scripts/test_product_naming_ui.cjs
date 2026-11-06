// SPDX-License-Identifier: AGPL-3.0-only
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('web/app.js');
const onboarding = read('web/connect-onboarding.js');
const services = read('web/connect-services.js');
const payments = read('web/payments.js');
const provider = read('web/provider-settings.js');
const pathways = read('web/care-pathways.js');
const acceptance = read('scripts/dev_clinic_acceptance.py');

for (const [source, marker] of [
  [app, 'Review the SunCharts EHR connection'],
  [app, 'The self-hosted SunCharts EHR works independently'],
  [onboarding, 'Your SunCharts EHR opens a secure outbound connection'],
  [onboarding, 'No public SunCharts EHR address'],
  [services, 'Your SunCharts EHR opens the connection'],
  [services, 'Open SunCharts Connect'],
  [payments, 'this SunCharts EHR connection'],
  [payments, 'SunCharts EHR never asks for or stores a clinic Stripe API key'],
  [payments, 'copy into SunCharts EHR'],
  [provider, 'encrypted in this SunCharts EHR instance'],
  [pathways, 'configured SunCharts EHR event'],
  [acceptance, 'SunCharts EHR /version build'],
  [acceptance, 'SunCharts EHR /ready must report'],
]) {
  assert.ok(source.includes(marker), `missing product identity: ${marker}`);
}

for (const [source, forbidden] of [
  [app, 'Review the EHR connection'],
  [app, 'The self-hosted EHR works independently'],
  [onboarding, 'Your EHR opens a secure outbound connection'],
  [onboarding, 'No public EHR address'],
  [services, 'Your EHR opens the connection'],
  [payments, 'this EHR connection'],
  [payments, 'This EHR never asks'],
  [payments, 'copy into the EHR'],
  [provider, 'encrypted in this EHR instance'],
  [pathways, 'configured EHR event'],
]) {
  assert.ok(!source.includes(forbidden), `generic product label returned: ${forbidden}`);
}

const renderedWeb = fs.readdirSync(path.join(root, 'web'))
  .filter(file => /\.(?:html|js)$/.test(file))
  .map(file => read(`web/${file}`))
  .join('\n');
assert.doesNotMatch(
  renderedWeb,
  />\s*(?:Open|Launch|Manage)\s+(?:the\s+)?EHR(?:\s|<|↗)/i,
  'native product actions must name SunCharts EHR explicitly',
);

// These phrases intentionally refer to records from any EHR, not product identity.
assert.match(app, /documentation authored in this EHR/);
assert.match(app, /does not switch your active EHR/);
assert.match(app, /Stage and import EHR exports/);

console.log('SunCharts EHR product naming UI assertions passed');
