// SPDX-License-Identifier: AGPL-3.0-only
import {NodeEditor,ClassicPreset} from 'rete';
import {AreaPlugin,AreaExtensions} from 'rete-area-plugin';
import {ConnectionPlugin,Presets as ConnectionPresets} from 'rete-connection-plugin';
import {LitPlugin,Presets} from '@retejs/lit-plugin';
import {LitElement,html,css} from 'lit';
import {connectionAllowed,layoutWorkflow} from './graph.js';

class WorkflowNode extends LitElement {
 static properties={data:{attribute:false},emit:{attribute:false}};
 static styles=css`:host{display:block;width:240px;min-width:240px;max-width:240px;box-sizing:border-box;border:1px solid var(--line,#d8e1e6);border-radius:10px;background:var(--surface,#fff);color:var(--ink,#233541);box-shadow:0 3px 12px #0001;font:13px/1.45 system-ui,sans-serif;user-select:none;cursor:grab}:host(:hover){border-color:var(--blue,#126d77)}:host([selected]){border-color:var(--blue,#126d77);background:var(--accent,#e6f2f2);box-shadow:0 0 0 2px var(--blue,#126d77)}header{border-top:4px solid var(--blue,#126d77);border-radius:9px 9px 0 0;padding:12px 14px 8px;font-size:14px;font-weight:700;white-space:normal;overflow-wrap:anywhere}p{margin:0;padding:0 14px 12px;color:var(--muted,#607482);font-size:13px;white-space:normal;overflow-wrap:anywhere}.condition{display:block;margin:0 12px 10px;padding:8px 9px;border-left:4px solid #b77a12;border-radius:5px;background:#fff4d8;color:#624710;font-size:13px;line-height:1.4;white-space:normal;overflow-wrap:anywhere}.condition b{display:block;margin-bottom:2px;font-size:12px;letter-spacing:.08em}.ports{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-top:1px solid var(--line,#d8e1e6);color:var(--muted,#607482);font-size:13px}.port{display:flex;gap:7px;align-items:center}.input{margin-left:-10px}.output{margin-right:-10px}.flag{display:inline-block;margin-top:5px;color:var(--blue,#126d77);font-weight:650}.configuration{display:inline-block;margin-top:6px;padding:3px 6px;border:1px solid var(--line,#d8e1e6);border-radius:4px;background:var(--surface-soft,#f4f7f8);color:var(--ink,#233541);font-size:13px;font-weight:650}.configuration[data-state=waiting]{border-style:dashed}.configuration[data-state=unsupported]{border-style:double;border-width:3px}`;
 render(){
  const node=this.data;if(!node)return html``;this.toggleAttribute('selected',!!node.selected);const info=node.controls.info;
  const contract=info.contract,row=(label,value,accent=false)=>html`<div style="display:grid;grid-template-columns:62px 1fr;gap:6px;padding:5px 7px;border-bottom:1px solid var(--line,#d8e1e6);background:var(--surface-soft,#f4f7f8)"><b style="font-size:12px;letter-spacing:.06em;color:var(--muted,#607482)">${label}</b><span style="font-size:12px;line-height:1.35;color:${accent?'var(--blue,#126d77)':'var(--ink,#233541)'};font-weight:${accent?'700':'500'};overflow-wrap:anywhere">${value}</span></div>`;
  return html`<header>${node.label}</header><p>${info.description}<br>${info.phase}${info.configuration?html`<br><span class="configuration" data-state=${info.configuration.state} title=${info.configuration.detail}>${info.configuration.label}</span>`:''}</p>${info.conditionLabel?html`<span class="condition"><b>RUNS ONLY IF</b>${info.conditionLabel}</span>`:''}${contract?html`<div style="margin:0 10px 10px;border:1px solid var(--line,#d8e1e6);border-radius:6px;overflow:hidden">${row('STARTS',contract.starts)}${row('USES',contract.input)}${row('DOES',contract.action)}${row('SENDS TO',contract.destination)}${row('CONTROL',contract.approval,true)}${row('RESULT',contract.result)}</div>`:''}<div class="ports"><span class="port input"><rete-ref .data=${{type:'socket',side:'input',key:'in',nodeId:node.id,payload:node.inputs.in.socket}} .emit=${this.emit}></rete-ref>Requires</span><span class="port output">Then<rete-ref .data=${{type:'socket',side:'output',key:'out',nodeId:node.id,payload:node.outputs.out.socket}} .emit=${this.emit}></rete-ref></span></div>`;
 }
}
class WorkflowSocket extends LitElement {static styles=css`:host{display:block;width:20px;height:20px;box-sizing:border-box;border:3px solid var(--surface,#fff);border-radius:50%;background:var(--blue,#126d77);box-shadow:0 0 0 1px var(--blue,#126d77);cursor:crosshair}`;render(){return html``;}}
if(!customElements.get('sun-workflow-node'))customElements.define('sun-workflow-node',WorkflowNode);
if(!customElements.get('sun-workflow-socket'))customElements.define('sun-workflow-socket',WorkflowSocket);
export async function mount(container,{steps,columns,labels,describeStep,describeContract,onSelect,onPosition,onConnection,onError,selected}){
 const editor=new NodeEditor(),area=new AreaPlugin(container),connection=new ConnectionPlugin(),render=new LitPlugin(),socket=new ClassicPreset.Socket('Workflow dependency');
 const conditionalTargets=new Set(steps.filter(step=>step.condition).map(step=>step.key));
 let loading=true,destroyed=false,synchronizing=Promise.resolve();
 connection.addPreset(ConnectionPresets.classic.setup());
 render.addPreset(Presets.classic.setup({customize:{
  node:context=>({emit})=>html`<sun-workflow-node .data=${context.payload} .emit=${emit}></sun-workflow-node>`,
  socket:()=>()=>html`<sun-workflow-socket></sun-workflow-socket>`,
  control:context=>()=>html`<div style="font-size:13px;line-height:1.5;color:var(--muted)">${context.payload.description}<br>${context.payload.approval?'Approval required · ':''}${context.payload.condition?'Conditional · ':''}${context.payload.phase}</div>`,
  connection:context=>({path})=>{const conditional=conditionalTargets.has(context.payload.target);return html`<svg style="overflow:visible;position:absolute;pointer-events:none" aria-label=${conditional?'Conditional path':'Required path'}><path d=${path} fill="none" stroke=${conditional?'#b77a12':'var(--blue,#126d77)'} stroke-width="3" stroke-dasharray=${conditional?'9 7':null}></path></svg>`;}
 }}));
 editor.use(area);area.use(connection);area.use(render);
 const accumulation=AreaExtensions.accumulateOnCtrl();
 const selection=AreaExtensions.selectableNodes(area,AreaExtensions.selector(),{accumulating:accumulation});
 AreaExtensions.simpleNodesOrder(area);AreaExtensions.restrictor(area,{scaling:{min:.2,max:2}});
 editor.addPipe(context=>{
  if(context.type==='connectioncreate'&&!loading){
   const candidate=context.data,all=editor.getConnections();
   if(!connectionAllowed(all,candidate.source,candidate.target)){onError('Connections must be unique and cannot create a workflow cycle.');return;}
  }
  if(!loading&&!destroyed&&['connectioncreated','connectionremoved'].includes(context.type))onConnection(context.data.source,context.data.target,context.type==='connectioncreated');
  return context;
 });
 area.addPipe(context=>{
  if(!loading&&!destroyed&&context.type==='nodepicked')onSelect(context.data.id);
  if(!loading&&!destroyed&&context.type==='nodedragged'){
   const position=area.nodeViews.get(context.data.id)?.position;
   if(position)onPosition(context.data.id,{x:Math.max(-100000,Math.min(100000,Math.round(position.x))),y:Math.max(-100000,Math.min(100000,Math.round(position.y)))});
  }
  return context;
 });
 const nodes=new Map();
 function conditionLabel(value){if(!value)return '';const field=value.field||'context field',operator={equals:'equals',not_equals:'does not equal',present:'has a value',absent:'has no value'}[value.operator]||value.operator||'matches';return ['present','absent'].includes(value.operator)?`${field} ${operator}`:`${field} ${operator} ${typeof value.value==='string'?value.value:JSON.stringify(value.value)}`;}
 function setNodeData(node,step){node.label=step.title;const info=node.controls.info;info.description=labels[step.kind]||step.kind;info.approval=!!step.manual_approval;info.condition=!!step.condition;info.conditionLabel=conditionLabel(step.condition);info.phase=columns.find(column=>column.key===step.phase)?.title||step.phase||'Workflow';info.configuration=describeStep?.(step);info.contract=describeContract?.(step);}
 for(const step of steps){
  const node=new ClassicPreset.Node(step.title);node.id=step.key;node.width=240;node.height=190;node.addInput('in',new ClassicPreset.Input(socket,'Requires',true));node.addOutput('out',new ClassicPreset.Output(socket,'Then',true));node.addControl('info',new ClassicPreset.Control());setNodeData(node,step);nodes.set(step.key,node);await editor.addNode(node);
 }
 async function place(layoutSteps,preserveSaved){
  // Lit renders asynchronously. Measure the actual cards, including wrapped titles.
  await new Promise(resolve=>requestAnimationFrame(resolve));
  if(destroyed)return;
  const sizes=new Map([...nodes].map(([key,node])=>{const element=area.nodeViews.get(key)?.element;node.width=Math.max(240,element?.offsetWidth||0);node.height=Math.max(190,element?.offsetHeight||0);return [key,{width:node.width,height:node.height}];}));
  const positions=layoutWorkflow(layoutSteps,{preserveSaved,sizes});
  for(const [key,position] of positions){
   if(destroyed)return;
   await area.translate(key,position);
   if(!preserveSaved&&!destroyed)onPosition(key,position);
  }
 }
 await place(steps,true);
 for(const step of steps)for(const dependency of step.depends_on||[])if(nodes.has(dependency)&&nodes.has(step.key))await editor.addConnection(new ClassicPreset.Connection(nodes.get(dependency),'out',nodes.get(step.key),'in'));
 if(selected&&nodes.has(selected))await selection.select(selected,false);
 async function focusStart(){
  const list=editor.getNodes();if(destroyed||!list.length)return;
  const bounds=AreaExtensions.getBoundingBox(area,list),width=container.clientWidth,height=container.clientHeight;
  const scale=Math.min(width*.9/bounds.width,height*.9/bounds.height,1);
  if(scale>=.7){await AreaExtensions.zoomAt(area,list);return;}
  // Large flows open at a readable size. Fit graph remains an explicit overview.
  const incoming=new Set(editor.getConnections().map(item=>item.target));
  const start=list.find(node=>!incoming.has(node.id))||list.reduce((left,node)=>area.nodeViews.get(node.id).position.x<area.nodeViews.get(left.id).position.x?node:left);
  const anchor=AreaExtensions.getBoundingBox(area,[start]);
  await area.area.zoom(.7,0,0);
  if(!destroyed)await area.area.translate(Math.min(32,width*.05)-anchor.left*.7,height/2-anchor.center.y*.7);
 }
 await focusStart();loading=false;
 const observer=new MutationObserver(()=>{if(!container.isConnected)destroy();});observer.observe(document.body,{childList:true,subtree:true});
 function destroy(){if(destroyed)return;destroyed=true;observer.disconnect();accumulation.destroy();area.destroy();}
 return {
  fit:()=>AreaExtensions.zoomAt(area,editor.getNodes()),
  focusStart,
  focusNode:async key=>{
   const node=nodes.get(key);if(destroyed||!node)return;
   const rect=AreaExtensions.getBoundingBox(area,[node]),width=container.clientWidth,height=container.clientHeight;
   await area.area.zoom(Math.min(1,width*.85/rect.width,height*.85/rect.height),0,0);
   if(!destroyed){const scale=area.area.transform.k;await area.area.translate(width/2-rect.center.x*scale,height/2-rect.center.y*scale);}
  },
  arrange:()=>{synchronizing=synchronizing.catch(()=>{}).then(async()=>{
   if(destroyed)return;
   const connections=editor.getConnections();await place([...nodes.keys()].map(key=>({key,depends_on:connections.filter(item=>item.target===key).map(item=>item.source)})),false);
   if(!destroyed)await focusStart();
  });return synchronizing;},
  zoom:factor=>area.area.zoom(area.area.transform.k*factor,container.clientWidth/2,container.clientHeight/2),
  updateStep:async step=>{const node=step&&nodes.get(step.key);if(node){if(step.condition)conditionalTargets.add(step.key);else conditionalTargets.delete(step.key);setNodeData(node,step);await area.update('node',node.id);for(const item of editor.getConnections().filter(item=>item.target===step.key))await area.update('connection',item.id);}},
  syncConnections:steps=>{synchronizing=synchronizing.then(async()=>{
   if(destroyed)return;loading=true;conditionalTargets.clear();for(const step of steps)if(step.condition)conditionalTargets.add(step.key);
   try{const desired=new Set(steps.flatMap(step=>(step.depends_on||[]).map(source=>`${source}\0${step.key}`)));
    for(const item of editor.getConnections())if(!desired.has(`${item.source}\0${item.target}`))await editor.removeConnection(item.id);
    const existing=new Set(editor.getConnections().map(item=>`${item.source}\0${item.target}`));
    for(const step of steps)for(const source of step.depends_on||[])if(nodes.has(source)&&nodes.has(step.key)&&!existing.has(`${source}\0${step.key}`))await editor.addConnection(new ClassicPreset.Connection(nodes.get(source),'out',nodes.get(step.key),'in'));
    for(const item of editor.getConnections())await area.update('connection',item.id);
   }finally{loading=false;}
  });return synchronizing;},
  destroy
 };
}
window.SunChartsWorkflowEditor={mount};
