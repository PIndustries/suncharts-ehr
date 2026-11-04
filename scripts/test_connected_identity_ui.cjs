const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const portal = fs.readFileSync(path.join(root, 'web/patient-portal.js'), 'utf8');
const browser = fs.readFileSync(path.join(root, 'src/browser.rs'), 'utf8');
const patient = fs.readFileSync(path.join(root, 'src/patient_portal.rs'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'src/connect_identity.rs'), 'utf8');

assert.match(index, /id="connect-login"[^>]+hidden/);
assert.match(app, /mode\.mode==='connect'/);
assert.match(app, /local-login-fields'\)\.hidden=connected/);
assert.match(browser, /connected && !recovery/);
assert.match(browser, /ENGINE_BREAK_GLASS_LOCAL_AUTH/);
assert.match(browser, /role != "owner"/);
assert.match(portal, /portalAuthMode\.mode==='connect'/);
assert.match(portal, /patient_sign_in_url/);
assert.match(patient, /connect_identity::connected/);
assert.match(identity, /patient_ehr_puuid/);
assert.match(identity, /patient_portal_accounts[\s\S]{0,220}WHERE tenant_id=\$1 AND patient_id=\$2/);
assert.match(identity, /managed-ehr\/identity\/introspect/);

console.log('connected identity staff and patient UI assertions passed');
