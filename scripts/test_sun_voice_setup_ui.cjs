// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const fixture=fs.readFileSync('scripts/test_sun_assistant_ui.cjs','utf8');
const foundation=vm.createContext({require,console});
vm.runInContext(fixture.slice(0,fixture.indexOf('\n(async()=>{')),foundation);
const harness=()=>vm.runInContext('harness()',foundation);
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
(async()=>{
 let h=harness();h.nodes['sun-settings']={open:false};h.setAvailability(Promise.resolve('downloadable'));await h.run('sunStartListening()');
 assert.equal(h.nodes['sun-settings'].open,true);assert.equal(h.nodes['sun-mic'].textContent,'Set up microphone');assert.equal(h.nodes['sun-mic'].disabled,false);assert.equal(h.recognizers.some(r=>r.started),false);assert.match(h.nodes['sun-status'].textContent,/Install/);
 let installed=0;h.Recognition.install=async options=>{installed++;assert.equal(options.processLocally,true);h.setAvailability(Promise.resolve('available'));return true;};await h.run('sunInstallVoice()');assert.equal(installed,1);assert.equal(h.nodes['sun-mic'].textContent,'Start microphone');assert.match(h.nodes['sun-status'].textContent,/Select Start microphone/);assert.equal(h.recognizers.some(r=>r.started),false,'install never begins recording');
 h=harness();h.setAvailability(Promise.resolve('downloading'));await h.run('sunCheckVoice()');h.Recognition.install=()=>{throw Error('must not start a second install');};await h.run('sunInstallVoice()');assert.equal(h.nodes['sun-mic'].textContent,'Check speech download');
 h=harness();h.setAvailability(Promise.resolve('downloadable'));await h.run('sunCheckVoice()');h.Recognition.install=async()=>false;await h.run('sunInstallVoice()');assert.match(h.nodes['sun-status'].textContent,/could not install/);assert.equal(h.nodes['sun-install-voice'].disabled,false);
 for(const failure of [false,true]){
  h=harness();const wait=deferred();h.setAvailability(wait.promise);const pending=h.run('sunCheckVoice()');h.context.me={role:'owner',tenant_id:'new-account'};h.nodes['sun-voice-note'].textContent='New session';if(failure)wait.reject(Error('late failure'));else wait.resolve('available');await pending;assert.equal(h.nodes['sun-voice-note'].textContent,'New session');
 }
 h=harness();h.setAvailability(Promise.resolve('available'));await h.run('sunCheckVoice()');const wait=deferred();h.setAvailability(wait.promise);const pending=h.run('sunStartListening()');h.context.me={role:'owner',tenant_id:'new-account'};wait.resolve('available');await pending;assert.equal(h.recognizers.some(r=>r.started),false,'stale check cannot begin audio for another session');
 console.log('PASS Sun voice setup states, explicit capture, download failure and stale account guards');
})().catch(error=>{console.error(error);process.exitCode=1;});
