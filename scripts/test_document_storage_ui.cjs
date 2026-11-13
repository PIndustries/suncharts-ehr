// SPDX-License-Identifier: AGPL-3.0-only
// Fixture-only checks for the owner "File storage" panel. No browser is launched.
'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/document-storage.js','utf8');
function fixture(responses){
 const nodes={'file-storage-panel':{innerHTML:''}},calls=[],handlers={};
 const context=vm.createContext({console,me:{role:'owner',user_id:'owner'},$:id=>nodes[id]||null,
  esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
  document:{addEventListener:(type,handler)=>{(handlers[type]??=[]).push(handler);}},
  api:async(path,method='GET',body)=>{calls.push([path,method,body]);const next=responses.shift();if(next instanceof Error)throw next;return next;}});
 vm.runInContext(source,context);
 return {context,nodes,calls,handlers,panel:()=>nodes['file-storage-panel'].innerHTML,run:code=>vm.runInContext(code,context)};
}
const state=(mode,database,stored,available=mode==='s3'?true:null)=>({mode,storage_available:available,files:{database:{count:database,bytes:database*10},s3:{count:stored,bytes:stored*10}}});
// Words a practice owner should never have to read, and no em dashes.
const plain=html=>{assert.doesNotMatch(html.replace(/<[^>]+>/g,' '),/\bS3\b|s3|bucket|\bobject\b|bytea|sha|endpoint|—/i);};
(async()=>{
 let f=fixture([state('database',12,0)]);
 assert.match(f.run('fileStoragePanel()'),/id="file-storage-panel"/);
 await f.run('loadFileStorage()');
 assert.deepEqual(f.calls,[['/api/v1/practice/document-storage','GET',undefined]]);
 assert.match(f.panel(),/<h3>File storage<\/h3>/);assert.match(f.panel(),/kept in the practice database/);assert.match(f.panel(),/12 files/);
 assert.doesNotMatch(f.panel(),/data-file-storage-move/);plain(f.panel());
 console.log('PASS database-only practice sees where files are kept and no move button');

 f=fixture([state('s3',0,1)]);await f.run('loadFileStorage()');
 assert.match(f.panel(),/kept in encrypted file storage/);assert.match(f.panel(),/1 file</);assert.doesNotMatch(f.panel(),/data-file-storage-move/);plain(f.panel());
 console.log('PASS fully moved practice has nothing left to do');

 // The move repeats until nothing remains, showing progress between calls.
 const seen=[];
 f=fixture([state('s3',60,5),{moved:25,remaining:35,failed:[],storage_available:true},{moved:25,remaining:10,failed:[],storage_available:true},{moved:10,remaining:0,failed:[],storage_available:true},state('s3',0,65)]);
 await f.run('loadFileStorage()');
 assert.match(f.panel(),/60 files saved earlier are still in the practice database/);assert.match(f.panel(),/<button type="button" class="primary" data-file-storage-move >Move files to file storage<\/button>/);plain(f.panel());
 const api=f.context.api;f.context.api=async(...args)=>{seen.push(f.panel());return api(...args);};
 assert.equal(f.handlers.click.length,1);
 f.handlers.click[0]({target:{closest:selector=>selector==='[data-file-storage-move]'?{}:null}});
 await f.run('moveFilesToStorage()');// A second start while one runs is ignored.
 await new Promise(resolve=>setTimeout(resolve,10));
 const moves=f.calls.filter(([path])=>path.endsWith('/move'));
 assert.equal(moves.length,3);assert.ok(moves.every(([,method,body])=>method==='POST'&&body===undefined));
 assert.match(seen[0],/Moved 0 of 60 files/);assert.match(seen[1],/Moved 25 of 60 files/);assert.match(seen[2],/Moved 50 of 60 files/);
 assert.match(seen[1],/data-file-storage-move disabled/);
 assert.match(f.panel(),/All files are now in file storage\. 60 files moved\./);assert.doesNotMatch(f.panel(),/data-file-storage-move/);plain(f.panel());
 console.log('PASS move repeats with progress until nothing remains');

 // Files that cannot be verified stay put and the loop stops instead of spinning.
 f=fixture([state('s3',3,0),{moved:1,remaining:2,failed:[{document_id:'d1',file_version:1,reason:'x'}],storage_available:true},{moved:0,remaining:2,failed:[{document_id:'d1',file_version:1,reason:'x'}],storage_available:true},state('s3',2,1)]);
 await f.run('loadFileStorage()');await f.run('moveFilesToStorage()');
 assert.equal(f.calls.filter(([path])=>path.endsWith('/move')).length,2);
 assert.match(f.panel(),/2 files could not be moved and stayed in the practice database\. Nothing was lost\./);assert.match(f.panel(),/data-file-storage-move/);plain(f.panel());
 console.log('PASS unmovable files are reported and never retried in a loop');

 // An outage part way through, and one before anything moved.
 f=fixture([state('s3',30,0),{moved:4,remaining:26,failed:[],storage_available:false},state('s3',26,4,false)]);
 await f.run('loadFileStorage()');await f.run('moveFilesToStorage()');
 assert.match(f.panel(),/File storage stopped responding after 4 files moved\. Nothing was lost\./);assert.match(f.panel(),/not responding right now/);assert.match(f.panel(),/data-file-storage-move disabled/);plain(f.panel());
 f=fixture([state('s3',30,0),new Error('File storage is temporarily unavailable. Try again in a few minutes.'),state('s3',30,0)]);
 await f.run('loadFileStorage()');await f.run('moveFilesToStorage()');
 assert.match(f.panel(),/temporarily unavailable\. Try again in a few minutes\. 0 files moved so far\. Nothing was lost\./);
 console.log('PASS outages stop the move with a plain message');

 f=fixture([state('database',2,7)]);await f.run('loadFileStorage()');
 assert.match(f.panel(),/7 files are kept in file storage, but file storage is turned off on this server/);plain(f.panel());
 f=fixture([]);f.context.me={role:'clinician'};assert.equal(f.run('fileStoragePanel()'),'');await f.run('loadFileStorage()');assert.equal(f.calls.length,0);
 console.log('PASS turned-off storage is called out and non-owners see nothing');
 plain(source.replace(/\/\/.*$/gm,'').replace(/state\.mode==='s3'|files\?\.s3\?\.count/g,''));
 assert.match(fs.readFileSync('web/specialty-workspace.js','utf8'),/fileStoragePanel\(\)/);
 assert.match(fs.readFileSync('web/index.html','utf8'),/<script src="\/document-storage\.js" defer><\/script>/);
 console.log('PASS panel is wired into Practice administration and uses plain wording');
})().catch(error=>{console.error(error);process.exit(1);});
