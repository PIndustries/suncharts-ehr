// SPDX-License-Identifier: AGPL-3.0-only
// Owner view of where patient files are kept, and the owner-started move of
// older files into file storage. The move is resumable: every request moves a
// small batch and can be repeated safely.
let fileStorageState=null,fileStorageMoving=false,fileStorageEpoch=0;
function fileStoragePanel(){
 return me?.role==='owner'?'<section class="panel" id="file-storage-panel"><h3>File storage</h3><p class="muted">Checking where files are kept.</p></section>':'';
}
function fileStorageCount(value){const n=Number(value)||0;return `${n.toLocaleString('en-US')} ${n===1?'file':'files'}`;}
function fileStorageView(state,progress='',problem=''){
 const inDatabase=Number(state.files?.database?.count)||0,stored=Number(state.files?.s3?.count)||0,on=state.mode==='s3';
 const parts=['<h3>File storage</h3>'];
 if(!on&&!stored)parts.push(`<p>Patient files are kept in the practice database.</p><p class="muted">${fileStorageCount(inDatabase)}</p>`);
 else if(!on)parts.push(`<p class="notice error">${fileStorageCount(stored)} ${stored===1?'is':'are'} kept in file storage, but file storage is turned off on this server, so ${stored===1?'it':'they'} cannot be opened. Contact support.</p><p class="muted">${fileStorageCount(inDatabase)} in the practice database</p>`);
 else{
  if(state.storage_available===false)parts.push('<p class="notice error">File storage is not responding right now. Files kept there cannot be opened until it is back. Try again in a few minutes.</p>');
  if(!inDatabase)parts.push(`<p>Patient files are kept in encrypted file storage.</p><p class="muted">${fileStorageCount(stored)}</p>`);
  else parts.push(`<p>New files are kept in encrypted file storage. ${fileStorageCount(inDatabase)} saved earlier ${inDatabase===1?'is':'are'} still in the practice database.</p><p class="muted">${fileStorageCount(stored)} already in file storage. Moving keeps every file. Each one is checked after it is copied, and it only leaves the database once the check passes.</p><button type="button" class="primary" data-file-storage-move ${fileStorageMoving||state.storage_available===false?'disabled':''}>Move files to file storage</button>`);
 }
 if(progress)parts.push(`<p role="status" data-file-storage-progress>${esc(progress)}</p>`);
 if(problem)parts.push(`<p class="notice error" role="alert">${esc(problem)}</p>`);
 return parts.join('');
}
function showFileStorage(progress='',problem=''){
 const panel=$('file-storage-panel');
 if(panel&&fileStorageState)panel.innerHTML=fileStorageView(fileStorageState,progress,problem);
 return Boolean(panel);
}
async function loadFileStorage(progress='',problem=''){
 if(me?.role!=='owner'||!$('file-storage-panel'))return;
 const account=me,epoch=++fileStorageEpoch;
 try{
  const state=await api('/api/v1/practice/document-storage');
  if(me!==account||epoch!==fileStorageEpoch)return;
  fileStorageState=state;showFileStorage(progress,problem);
 }catch(error){
  if(me!==account||epoch!==fileStorageEpoch)return;
  const panel=$('file-storage-panel');
  if(panel)panel.innerHTML=`<h3>File storage</h3><p class="notice error">${esc(error.message||'File storage details could not be loaded.')}</p>`;
 }
}
async function moveFilesToStorage(){
 if(fileStorageMoving||!fileStorageState)return;
 fileStorageMoving=true;
 const account=me,total=Number(fileStorageState.files?.database?.count)||0;
 let moved=0,progress='',problem='';
 try{
  for(;;){
   if(!showFileStorage(`Moved ${moved.toLocaleString('en-US')} of ${fileStorageCount(total)}. You can leave this page and continue later.`))return;
   const result=await api('/api/v1/practice/document-storage/move','POST');
   if(me!==account)return;
   moved+=Number(result.moved)||0;
   fileStorageState={...fileStorageState,storage_available:result.storage_available,files:{...fileStorageState.files,database:{...fileStorageState.files.database,count:result.remaining}}};
   if(result.remaining===0){progress=`All files are now in file storage. ${fileStorageCount(moved)} moved.`;break;}
   if(result.storage_available===false){problem=`File storage stopped responding after ${fileStorageCount(moved)} moved. Nothing was lost. Try again in a few minutes.`;break;}
   if(!result.moved){problem=`${fileStorageCount(result.remaining)} could not be moved and stayed in the practice database. Nothing was lost. Contact support.`;break;}
  }
 }catch(error){
  if(me!==account)return;
  problem=`${error.message||'The move stopped.'} ${fileStorageCount(moved)} moved so far. Nothing was lost.`;
 }finally{fileStorageMoving=false;}
 await loadFileStorage(progress,problem);
}
document.addEventListener('click',event=>{
 if(event.target.closest?.('[data-file-storage-move]'))void moveFilesToStorage();
});
