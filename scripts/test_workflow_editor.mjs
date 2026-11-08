// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {connectionAllowed,layoutWorkflow} from '../web/workflow-editor/graph.js';
const graph=[{source:'intake',target:'review'},{source:'review',target:'sun'},{source:'sun',target:'output-review'}];
assert.equal(connectionAllowed(graph,'output-review','intake'),false,'a long cycle cannot be connected');
assert.equal(connectionAllowed(graph,'sun','review'),false,'a short cycle cannot be connected');
assert.equal(connectionAllowed(graph,'review','sun'),false,'duplicate dependency rejected');
assert.equal(connectionAllowed(graph,'review','review'),false,'self dependency rejected');
assert.equal(connectionAllowed(graph,'intake','output-review'),true,'additional prerequisite allowed');
assert.equal(connectionAllowed(graph,'intake','parallel-task'),true,'parallel branch allowed');
assert.equal(connectionAllowed([...graph,{source:'output-review',target:'review'}],'intake','separate'),true,'legacy cycle elsewhere cannot hang validation');
const step=(key,depends_on=[],extra={})=>({key,title:key,phase:'same-phase',kind:'staff_task',depends_on,...extra});
function clearCards(steps,positions,sizes=new Map()){
 for(let i=0;i<steps.length;i++)for(let j=i+1;j<steps.length;j++){
  const a=positions.get(steps[i].key),b=positions.get(steps[j].key),as=sizes.get(steps[i].key)||{width:240,height:190},bs=sizes.get(steps[j].key)||{width:240,height:190};
  assert.ok(a.x+as.width+60<=b.x||b.x+bs.width+60<=a.x||a.y+as.height+60<=b.y||b.y+bs.height+60<=a.y,`${steps[i].key} and ${steps[j].key} have a clear gutter`);
 }
}
function forward(steps,positions){for(const node of steps)for(const parent of node.depends_on)assert.ok(positions.get(parent).x+240<positions.get(node.key).x,`${parent} flows left to right into ${node.key}`);}
const chain=[step('last',['middle']),step('first'),step('middle',['first'])];
const chainPositions=layoutWorkflow(chain);
forward(chain,chainPositions);
assert.equal(new Set([...chainPositions.values()].map(p=>p.y)).size,1,'an out-of-order same-phase chain is aligned horizontally');
const diamond=[step('intake'),step('lab',['intake']),step('chart',['intake']),step('review',['lab','chart']),step('finish',['review'])];
const diamondPositions=layoutWorkflow(diamond);
forward(diamond,diamondPositions);clearCards(diamond,diamondPositions);
assert.equal(diamondPositions.get('lab').x,diamondPositions.get('chart').x,'parallel siblings share their dependency rank');
assert.equal(diamondPositions.get('review').y,(diamondPositions.get('lab').y+diamondPositions.get('chart').y)/2,'join is centered between its branches');
assert.equal(diamondPositions.get('intake').y,diamondPositions.get('review').y,'fork and join align');
assert.deepEqual(layoutWorkflow(diamond),diamondPositions,'layout is deterministic');
const large=[step('start'),...Array.from({length:48},(_,i)=>step(`branch-${i}`,['start'])),step('join',Array.from({length:48},(_,i)=>`branch-${i}`))];
const sizes=new Map(large.map((node,i)=>[node.key,{width:240,height:i%3===0?360:190}]));
const largePositions=layoutWorkflow(large,{sizes});
forward(large,largePositions);clearCards(large,largePositions,sizes);
assert.ok([...largePositions.values()].every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.abs(p.x)<=100000&&Math.abs(p.y)<=100000),'wide fan-out stays within stored position bounds');
const disconnected=[...diamond,step('other'),step('other-next',['other']),step('single')];
const disconnectedPositions=layoutWorkflow(disconnected);
forward(disconnected,disconnectedPositions);clearCards(disconnected,disconnectedPositions);
assert.ok(disconnectedPositions.get('other').y>Math.max(...diamond.map(node=>disconnectedPositions.get(node.key).y))+190,'unrelated flows have their own vertical space');
const manual=diamond.map((node,i)=>({...node,editor_position:{x:i*11-77,y:i*13-88}}));
const before=JSON.stringify(manual),manualPositions=layoutWorkflow(manual);
for(const node of manual)assert.deepEqual(manualPositions.get(node.key),node.editor_position,'opening a saved graph preserves every exact manual position');
assert.equal(JSON.stringify(manual),before,'layout does not mutate saved input');
const arranged=layoutWorkflow(manual,{preserveSaved:false});
forward(manual,arranged);clearCards(manual,arranged);
const mixed=[step('saved',[],{editor_position:{x:360,y:0}}),step('new',['saved']),step('newer',['saved'])];
const mixedPositions=layoutWorkflow(mixed);
assert.deepEqual(mixedPositions.get('saved'),mixed[0].editor_position);clearCards(mixed,mixedPositions);
assert.ok(mixedPositions.get('new').x>mixedPositions.get('saved').x+240,'new children follow the actual saved parent position');
const moved=[step('grandchild',['child']),step('child',['moved']),step('moved',[],{editor_position:{x:1200,y:140}})];
const movedPositions=layoutWorkflow(moved);forward(moved,movedPositions);clearCards(moved,movedPositions);
assert.deepEqual(movedPositions.get('moved'),{x:1200,y:140},'automatic child placement preserves the moved parent');
const studioSource=readFileSync(new URL('../web/workflow-studio.js',import.meta.url),'utf8');
const editorSource=readFileSync(new URL('../web/workflow-editor/index.js',import.meta.url),'utf8');
assert.match(editorSource,/RUNS ONLY IF/,'conditional nodes show their exact condition on the canvas');
assert.match(editorSource,/>Requires</,'dependency input is labeled as a prerequisite');
assert.match(editorSource,/>Then</,'dependency output explains downstream flow');
assert.match(studioSource,/Multiple outgoing lines<\/b> start parallel work/,'the editor explains that fan-out is parallel rather than an implicit condition');
for(const name of ['studioJourney','studioBookedJourney']){
 const json=studioSource.match(new RegExp(`const ${name}=(.*);`))[1].replace('studioDefaultColumns','[]'),steps=JSON.parse(json).definition.steps;
 const positions=layoutWorkflow(steps);forward(steps,positions);clearCards(steps,positions);
 const lastX=Math.max(...[...positions.values()].map(p=>p.x));
 assert.ok(lastX<=(steps.length-1)*328,'starter workflows use the compact dependency spacing');
}
const invalid=[step('cycle-a',['cycle-b']),step('cycle-b',['cycle-a']),step('orphan',['missing']),step('self',['self'])];
const fallback=layoutWorkflow(invalid);
assert.equal(fallback.size,invalid.length,'legacy invalid edges cannot hang layout');clearCards(invalid,fallback);
assert.equal(layoutWorkflow([]).size,0);

// Exercise the mount contract without browser dependencies: mounting is read-only;
// Arrange persists each position, uses current edges, then opens a readable start.
const calls=[],areas=[];
class Editor {
 constructor(){this.nodes=[];this.connections=[];this.pipes=[];}
 use(area){this.area=area;}addPipe(pipe){this.pipes.push(pipe);}
 async addNode(node){this.nodes.push(node);this.area.nodeViews.set(node.id,{position:{x:0,y:0},element:{offsetWidth:240,offsetHeight:node.id==='lab'?330:190}});}
 getNodes(){return this.nodes;}getConnections(){return this.connections;}
 async addConnection(item){this.connections.push(item);}
 async removeConnection(id){this.connections=this.connections.filter(item=>item.id!==id);}
}
class Area {
 constructor(){this.nodeViews=new Map();this.area={transform:{k:1,x:0,y:0},async zoom(k){this.transform.k=k;calls.push(['viewzoom',k]);},async translate(x,y){this.transform.x=x;this.transform.y=y;calls.push(['viewtranslate',x,y]);}};areas.push(this);}
 use(){}addPipe(){}async update(){}
 async translate(key,position){this.nodeViews.get(key).position={...position};calls.push(['translate',key]);}
 destroy(){calls.push(['destroy']);}
}
class Node {constructor(label){this.label=label;this.inputs={};this.outputs={};this.controls={};}addInput(key,value){this.inputs[key]=value;}addOutput(key,value){this.outputs[key]=value;}addControl(key,value){this.controls[key]=value;}}
class Plugin {addPreset(){}}
const preset={classic:{setup(){return {};}}};
function bounds(area,nodes){const rects=nodes.map(node=>({...area.nodeViews.get(node.id).position,width:node.width,height:node.height})),left=Math.min(...rects.map(rect=>rect.x)),right=Math.max(...rects.map(rect=>rect.x+rect.width)),top=Math.min(...rects.map(rect=>rect.y)),bottom=Math.max(...rects.map(rect=>rect.y+rect.height));return {left,right,top,bottom,width:right-left,height:bottom-top,center:{x:(left+right)/2,y:(top+bottom)/2}};}
let nextConnection=0;
const context=vm.createContext({NodeEditor:Editor,AreaPlugin:Area,ConnectionPlugin:Plugin,LitPlugin:Plugin,ConnectionPresets:preset,Presets:preset,connectionAllowed,layoutWorkflow,ClassicPreset:{Node,Socket:class{},Input:class{},Output:class{},Control:class{},Connection:class{constructor(source,_out,target){this.id=String(++nextConnection);this.source=source.id;this.target=target.id;}}},AreaExtensions:{accumulateOnCtrl:()=>({destroy(){}}),selectableNodes:()=>({select:async key=>calls.push(['select',key])}),selector(){},simpleNodesOrder(){},restrictor(){},getBoundingBox:bounds,zoomAt:async(area,nodes)=>{const rect=bounds(area,nodes);area.area.transform.k=Math.min(630*.9/rect.width,600*.9/rect.height,1);calls.push(['fit']);}},LitElement:class{},html(){},css(){},customElements:{get:()=>true},window:{},document:{body:{}},MutationObserver:class{observe(){}disconnect(){}},requestAnimationFrame:callback=>callback(),console});
vm.runInContext(readFileSync(new URL('../web/workflow-editor/index.js',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export async function mount','async function mount'),context);
const editor=await context.window.SunChartsWorkflowEditor.mount({isConnected:true,clientWidth:630,clientHeight:600},{steps:manual,columns:[],labels:{},selected:'review',onSelect(){},onPosition:(key,position)=>calls.push(['persist',key,{...position}]),onConnection(){},onError:message=>assert.fail(message)});
assert.equal(calls.filter(call=>call[0]==='persist').length,0,'default mount never dirties the definition');
for(const node of manual)assert.deepEqual(areas[0].nodeViews.get(node.key).position,node.editor_position);
await editor.arrange();
assert.equal(calls.filter(call=>call[0]==='persist').length,manual.length,'explicit arrange persists every node through onPosition');
assert.equal(calls.at(-1)[0],'viewtranslate','arrange focuses the start after all position callbacks');
assert.equal(areas[0].area.transform.k,.7,'arranged large flow keeps readable zoom');
assert.ok(calls.findLastIndex(call=>call[0]==='persist')<calls.findLastIndex(call=>call[0]==='viewzoom'),'viewport changes follow all draft position callbacks');
assert.equal(calls.filter(call=>call[0]==='select').length,1,'arrange preserves selection');
const mountedPositions=new Map([...areas[0].nodeViews].map(([key,view])=>[key,view.position]));
clearCards(manual,mountedPositions,new Map(manual.map(node=>[node.key,{width:240,height:node.key==='lab'?330:190}])));
await editor.syncConnections([step('intake',['finish']),step('lab',['intake']),step('chart',['lab']),step('review',['chart']),step('finish')]);
await editor.arrange();
assert.ok(areas[0].nodeViews.get('finish').position.x<areas[0].nodeViews.get('intake').position.x,'arrange reads edited connections instead of the initial definition');
await editor.fit();assert.equal(calls.at(-1)[0],'fit');assert.ok(areas[0].area.transform.k<.7,'explicit Fit graph still offers a full overview');
await editor.focusStart();assert.equal(areas[0].area.transform.k,.7);
const anchor=areas[0].nodeViews.get('finish').position,transform=areas[0].area.transform;
assert.equal(anchor.x*transform.k+transform.x,31.5,'current dependency root is anchored at the left inset');
assert.equal((anchor.y+190/2)*transform.k+transform.y,300,'current dependency root is centered vertically');
const persistedBeforeFocus=calls.filter(call=>call[0]==='persist').length;
await editor.focusNode('review');
const selectedRect=bounds(areas[0],[{id:'review',width:240,height:190}]),focused=areas[0].area.transform;
assert.equal(selectedRect.center.x*focused.k+focused.x,315,'focus selected centers its card horizontally');
assert.equal(selectedRect.center.y*focused.k+focused.y,300,'focus selected centers its card vertically');
assert.equal(calls.filter(call=>call[0]==='persist').length,persistedBeforeFocus,'focus never changes saved positions');
const beforeMissingFocus=calls.length;await editor.focusNode('missing');assert.equal(calls.length,beforeMissingFocus);
editor.destroy();const afterDestroy=calls.length;await editor.arrange();assert.equal(calls.length,afterDestroy,'destroyed editors cannot write positions');
const longChain=Array.from({length:15},(_,i)=>step(`task-${i}`,i?[`task-${i-1}`]:[]));
const longEditor=await context.window.SunChartsWorkflowEditor.mount({isConnected:true,clientWidth:630,clientHeight:600},{steps:longChain,columns:[],labels:{},onSelect(){},onPosition:()=>assert.fail('opening an unsaved graph must not dirty it'),onConnection(){},onError:message=>assert.fail(message)});
assert.equal(areas[1].area.transform.k,.7,'initial 15-node flow opens at readable zoom instead of a miniature overview');
const first=areas[1].nodeViews.get('task-0').position;
assert.equal(first.x*.7+areas[1].area.transform.x,31.5);assert.equal((first.y+95)*.7+areas[1].area.transform.y,300);
longEditor.destroy();
console.log('PASS workflow connection safety, dependency layout, saved positions, Arrange persistence and readable start versus explicit Fit overview');
