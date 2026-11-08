// SPDX-License-Identifier: AGPL-3.0-only
export function connectionAllowed(connections,source,target){
 if(!source||!target||source===target||connections.some(item=>item.source===source&&item.target===target))return false;
 const pending=[target],seen=new Set();
 while(pending.length){const id=pending.pop();if(id===source)return false;if(seen.has(id))continue;seen.add(id);for(const item of connections)if(item.source===id)pending.push(item.target);}
 return true;
}

// Longest dependency paths set columns; neighboring branches set vertical order.
// Saved coordinates are user-owned, so automatic placement only moves new nodes.
export function layoutWorkflow(steps,{preserveSaved=true,sizes=new Map()}={}){
 const width=240,height=190,columnGap=88,rowGap=70;
 const nodes=new Map();
 for(const step of steps)if(step?.key&&!nodes.has(step.key)){
  const size=sizes.get(step.key)||{};
  nodes.set(step.key,{step,index:nodes.size,parents:[],children:[],rank:0,width:Math.max(width,Number.isFinite(size.width)?size.width:width),height:Math.max(height,Number.isFinite(size.height)?size.height:height)});
 }
 for(const node of nodes.values())for(const key of new Set(node.step.depends_on||[]))if(key!==node.step.key&&nodes.has(key)){
  node.parents.push(nodes.get(key));nodes.get(key).children.push(node);
 }
 const remaining=new Set(nodes.values()),indegree=new Map([...nodes.values()].map(node=>[node,node.parents.length]));
 while(remaining.size){
  // Invalid legacy cycles must not hang the editor. Server validation still rejects them.
  const node=[...remaining].find(item=>indegree.get(item)===0)||remaining.values().next().value;
  remaining.delete(node);
  for(const child of node.children)if(remaining.has(child)){
   child.rank=Math.max(child.rank,node.rank+1);indegree.set(child,indegree.get(child)-1);
  }
 }
 const columnWidths=[];
 for(const node of nodes.values())columnWidths[node.rank]=Math.max(columnWidths[node.rank]||0,node.width);
 const columns=[0];
 for(let rank=1;rank<columnWidths.length;rank++)columns[rank]=columns[rank-1]+columnWidths[rank-1]+columnGap;
 const positions=new Map(),visited=new Set();let componentTop=0;
 for(const start of nodes.values()){
  if(visited.has(start))continue;
  const component=[],pending=[start];visited.add(start);
  while(pending.length){const node=pending.shift();component.push(node);for(const next of [...node.parents,...node.children])if(!visited.has(next)){visited.add(next);pending.push(next);}}
  const layers=[];
  for(const node of component){(layers[node.rank]||=[]).push(node);}
  const centers=new Map();
  for(const layer of layers.filter(Boolean)){
   layer.sort((a,b)=>a.index-b.index);let y=0;
   for(const node of layer){centers.set(node,y+node.height/2);y+=node.height+rowGap;}
  }
  function align(layer,relation){
   const wanted=new Map(layer.map(node=>{const adjacent=node[relation];return [node,adjacent.length?adjacent.reduce((sum,item)=>sum+centers.get(item),0)/adjacent.length:centers.get(node)];}));
   layer.sort((a,b)=>wanted.get(a)-wanted.get(b)||a.index-b.index);
   let bottom=-Infinity;
   for(const node of layer){const top=Math.max(wanted.get(node)-node.height/2,bottom+rowGap);centers.set(node,top+node.height/2);bottom=top+node.height;}
   const shift=layer.reduce((sum,node)=>sum+wanted.get(node)-centers.get(node),0)/layer.length;
   for(const node of layer)centers.set(node,centers.get(node)+shift);
  }
  // Two deterministic forward/backward sweeps reduce crossed branches and center joins.
  for(let pass=0;pass<2;pass++){
   for(const layer of layers.filter(Boolean))align(layer,'parents');
   for(const layer of layers.filter(Boolean).reverse())align(layer,'children');
  }
  const top=Math.min(...component.map(node=>centers.get(node)-node.height/2));
  let bottom=componentTop;
  for(const node of component){const y=Math.round(componentTop+centers.get(node)-node.height/2-top);positions.set(node.step.key,{x:columns[node.rank],y});bottom=Math.max(bottom,y+node.height);}
  componentTop=bottom+rowGap*2;
 }
 const occupied=[];
 function remember(node,position){occupied.push({...position,width:node.width,height:node.height});positions.set(node.step.key,position);}
 const saved=new Set();
 if(preserveSaved)for(const node of nodes.values()){
  const position=node.step.editor_position;
  if(position&&Number.isFinite(position.x)&&Number.isFinite(position.y)&&Math.abs(position.x)<=100000&&Math.abs(position.y)<=100000){saved.add(node.step.key);remember(node,{x:position.x,y:position.y});}
 }
 // Leave existing manual arrangements untouched, including intentional overlaps.
 // New nodes avoid both those rectangles and earlier automatically placed nodes.
 for(const node of [...nodes.values()].sort((a,b)=>a.rank-b.rank||a.index-b.index))if(!saved.has(node.step.key)){
  const position={...positions.get(node.step.key)};
  // New nodes follow the actual positions of their parents, including manually
  // moved cards. Never move a saved card to make the automatic layout fit.
  const parentRight=Math.max(position.x,...node.parents.map(parent=>positions.get(parent.step.key).x+parent.width+columnGap));
  if(parentRight<=100000)position.x=parentRight;
  for(;;){const collisions=occupied.filter(rect=>position.x<rect.x+rect.width+rowGap&&position.x+node.width+rowGap>rect.x&&position.y<rect.y+rect.height+rowGap&&position.y+node.height+rowGap>rect.y);if(!collisions.length)break;position.y=Math.max(...collisions.map(rect=>rect.y+rect.height+rowGap));}
  remember(node,position);
 }
 return positions;
}
