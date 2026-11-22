// Collect payment across several encounters: the amount is shared out in order, cash is recorded
// once for each encounter under one payment, a card request carries the parts, and the receipt
// shows one tender and what each encounter received.
const assert=require('assert'),fs=require('fs'),vm=require('vm'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../web/patient-revenue.js'),'utf8');
const pick=name=>{const at=source.indexOf(`function ${name}(`);assert(at>=0,name);let depth=0,i=source.indexOf('{',at);for(;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)break;}return source.slice(source.lastIndexOf('\n',at)+1,i+1);};
const names=['collectGroupField','collectChosen','collectOthers','collectChosenLeft','collectParts','collectCardFields','collectTakenCents','collectEncounterLabel','collectEncountersMarkup','paymentTenderLines','paymentGroupReceiptFacts'];
const sandbox={collectDialog:{},workspace:{visits:[{appointment_id:'a1',encounter_number:7},{appointment_id:'a2',encounter_number:3},{appointment_id:'a3',encounter_number:5}],appointments:[]},
 esc:v=>String(v),money:c=>'$'+(c/100).toFixed(2),encounterNumberText:v=>v?`ENC-${String(v.encounter_number).padStart(4,'0')}`:'',human:v=>v};
vm.createContext(sandbox);
vm.runInContext(`let collectSession={target:null,owedAtOpen:0,taken:[],group:'g1',encounters:[],current:'a1',typed:false};\n${names.map(pick).join('\n')}\nthis.session=v=>{collectSession=v;};`,sandbox);
const session=encounters=>sandbox.session({target:null,owedAtOpen:0,taken:[],group:'g1',encounters,current:'a1',typed:false});
const enc=(appointment,owes,on=true,paid=0)=>({appointment,owes,paid,on});
const plain=value=>JSON.parse(JSON.stringify(value));

// One encounter only: nothing changes, and a card request carries no parts.
session([enc('a1',3000)]);
assert.equal(sandbox.collectParts(3000),null);
assert.deepEqual(plain(sandbox.collectCardFields(3000,'a1')),{payment_group_id:'g1'});
assert.equal(sandbox.collectEncountersMarkup(),'');

// Three encounters: the open one first, then the others in order, each up to what it owes.
session([enc('a1',3000),enc('a2',4000),enc('a3',2500)]);
assert.equal(sandbox.collectChosenLeft(),9500);
assert.deepEqual(plain(sandbox.collectParts(9500)),[{appointment_id:'a1',amount_cents:3000},{appointment_id:'a2',amount_cents:4000},{appointment_id:'a3',amount_cents:2500}]);
// A smaller amount stops where the money runs out.
assert.deepEqual(plain(sandbox.collectParts(500)),[{appointment_id:'a1',amount_cents:500}]);
assert.deepEqual(plain(sandbox.collectParts(5000)),[{appointment_id:'a1',amount_cents:3000},{appointment_id:'a2',amount_cents:2000}]);
// More than is owed stays with the first encounter as credit; the parts still add up.
assert.deepEqual(plain(sandbox.collectParts(10000)),[{appointment_id:'a1',amount_cents:3500},{appointment_id:'a2',amount_cents:4000},{appointment_id:'a3',amount_cents:2500}]);
// A card request for several encounters carries the parts; for the open one alone it does not.
assert.deepEqual(plain(sandbox.collectCardFields(5000,'a1')).splits,[{appointment_id:'a1',amount_cents:3000},{appointment_id:'a2',amount_cents:2000}]);
assert.equal(sandbox.collectCardFields(500,'a1').splits,undefined);
// Unticked encounters are left out, and money already taken this visit is counted.
session([enc('a1',3000,true,3000),enc('a2',4000,false),enc('a3',2500)]);
assert.deepEqual(plain(sandbox.collectParts(2500)),[{appointment_id:'a3',amount_cents:2500}]);
assert.deepEqual(plain(sandbox.collectCardFields(2500,'a1')).splits,[{appointment_id:'a3',amount_cents:2500}],'a charge made from the open encounter can pay only for another');
const markup=sandbox.collectEncountersMarkup();
assert(markup.includes('Pay for')&&markup.includes('ENC-0007')&&markup.includes('This encounter')&&markup.includes('Paid'),markup);
assert(markup.includes('data-collect-all="all"')&&markup.includes('Select all'),markup);
assert(/data-collect-encounter="a2"(?! checked)/.test(markup),'the unticked encounter is unticked');
assert(markup.includes('1 of 2 encounters · $25.00'),markup);

// Receipt: cash recorded once per encounter is one Cash line; each encounter's share is listed.
const facts=sandbox.paymentGroupReceiptFacts([
 {id:'r1',appointment_id:'a1',amount_cents:3000,method:'cash',occurred_on:'2026-11-21'},
 {id:'r2',appointment_id:'a2',amount_cents:2000,method:'cash',occurred_on:'2026-11-21'},
 {id:'r3',appointment_id:'a1',amount_cents:4500,method:'external',occurred_on:'2026-11-21',hosted_checkout:{refunded_cents:0,splits:[{appointment_id:'a2',amount_cents:2000,refunded_cents:0},{appointment_id:'a3',amount_cents:2500,refunded_cents:0}]}}],{});
assert.deepEqual(plain(facts.lines.map(l=>[l.label,l.amount])),[['Cash',5000],['Card',4500]]);
assert.equal(facts.total,9500);
assert.deepEqual(plain(facts.encounters),[{label:'ENC-0007',amount:3000},{label:'ENC-0003',amount:4000},{label:'ENC-0005',amount:2500}]);
// Two cash parts on the same encounter stay two lines, as before.
const same=sandbox.paymentGroupReceiptFacts([{id:'r1',appointment_id:'a1',amount_cents:500,method:'cash'},{id:'r2',appointment_id:'a1',amount_cents:700,method:'cash'}],{});
assert.equal(same.lines.length,2);assert.equal(same.encounters.length,0);
console.log('ok collect several encounters');
