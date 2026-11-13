// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Staff screens must stay readable: no text below 12px and a 15px body size.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const web=path.join(__dirname,'..','web');
const printOnly=new Set(['avs-print.css','patient-print.css','cms1500.css']);
const patientFacing=new Set(['patient-portal.css','previsit.css']);
const sheets=fs.readdirSync(web).filter(name=>name.endsWith('.css')&&!printOnly.has(name));
const staffSheets=sheets.filter(name=>!patientFacing.has(name));
assert.ok(staffSheets.includes('style.css')&&staffSheets.includes('theme.css')&&staffSheets.length>=10,'the staff stylesheets are present');

const base=fs.readFileSync(path.join(web,'style.css'),'utf8');
const tokens=Object.fromEntries([...base.matchAll(/(--fs-[a-z0-9]+):(\d+(?:\.\d+)?)px/g)].map(match=>[match[1],Number(match[2])]));
for(const name of ['--fs-eyebrow','--fs-xs','--fs-sm','--fs-body','--fs-md','--fs-lg','--fs-xl','--fs-h1'])assert.ok(Number.isFinite(tokens[name]),`${name} is defined in the base stylesheet`);
assert.ok(tokens['--fs-body']>=15,'body text is at least 15px');
assert.ok(tokens['--fs-sm']>=14,'secondary text is at least 14px');
assert.ok(tokens['--fs-xs']>=13,'the smallest ordinary text is at least 13px');
assert.ok(tokens['--fs-eyebrow']>=12,'uppercase labels are at least 12px');
assert.ok(Object.values(tokens).every(size=>size>=12),'no type token is below 12px');
assert.match(base,/body\{[^}]*font:var\(--fs-body\)\/var\(--lh-body\)/,'the page body uses the body size and line-height tokens');
const lineHeight=Number(/--lh-body:([\d.]+)/.exec(base)?.[1]);
assert.ok(lineHeight>=1.45,'body line-height is at least 1.45');
assert.ok(Number(/--control-height:(\d+)px/.exec(base)?.[1])>=36,'buttons and inputs are at least 36px tall');

// Every literal size, in any unit that resolves against the 16px root, in a font-size or font shorthand.
function literalSizes(css){
 const found=[];
 const clean=css.replace(/\/\*[\s\S]*?\*\//g,'');
 for(const match of clean.matchAll(/font-size:\s*([^;}]+)/g)){
  const value=match[1].trim();
  for(const size of value.matchAll(/(\d*\.?\d+)(px|rem|pt)\b/g))found.push([value,Number(size[1])*(size[2]==='rem'?16:size[2]==='pt'?4/3:1)]);
 }
 for(const match of clean.matchAll(/(?:^|[;{\s])font:\s*([^;}]+)/g)){
  const size=/(\d*\.?\d+)(px|rem)(?:\/|\s)/.exec(match[1]);
  if(size)found.push([match[1].trim(),Number(size[1])*(size[2]==='rem'?16:1)]);
 }
 return found;
}
assert.deepEqual(literalSizes('a{font-size:11px}b{font:bold 10px/1 x}c{font-size:.7rem}d{font-size:0}').map(([,px])=>Math.round(px*10)/10),[11,11.2,10],'the scanner sees px, rem and shorthand sizes');
for(const name of staffSheets){
 const small=literalSizes(fs.readFileSync(path.join(web,name),'utf8')).filter(([,px])=>px>0&&px<12);
 assert.deepEqual(small,[],`${name} declares no font-size below 12px`);
}
for(const name of patientFacing){
 const small=literalSizes(fs.readFileSync(path.join(web,name),'utf8')).filter(([,px])=>px>0&&px<14);
 assert.deepEqual(small,[],`${name} (patient-facing) declares no font-size below 14px`);
}
// Templates in scripts may not shrink text with inline styles either.
for(const name of fs.readdirSync(web).filter(file=>file.endsWith('.js'))){
 const source=fs.readFileSync(path.join(web,name),'utf8');
 const small=[...source.matchAll(/font-size:\s*(\d*\.?\d+)px/g)].map(match=>Number(match[1])).filter(px=>px>0&&px<12);
 assert.deepEqual(small,[],`${name} has no inline font-size below 12px`);
 const shorthand=[...source.matchAll(/font:\s*(?:[a-z0-9]+\s+)*(\d*\.?\d+)px\//g)].map(match=>Number(match[1])).filter(px=>px<12);
 assert.deepEqual(shorthand,[],`${name} has no inline font shorthand below 12px`);
}
// Muted text keeps WCAG AA contrast on every surface it sits on, in both themes.
const theme=fs.readFileSync(path.join(web,'theme.css'),'utf8');
const luminance=hex=>{const h=hex.replace('#','');const full=h.length===3?[...h].map(c=>c+c).join(''):h;return [0,2,4].map(i=>parseInt(full.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);};
const contrast=(a,b)=>{const [x,y]=[luminance(a),luminance(b)];return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
const lightMuted=[...base.matchAll(/--muted:(#[0-9a-f]{3,6})/g)].map(match=>match[1]).concat(/:root\[data-theme=light\][^{]*\{[^}]*--muted:(#[0-9a-f]{3,6})/.exec(theme)?.[1]||[]);
assert.ok(lightMuted.length>=1);
for(const muted of lightMuted)for(const surface of ['#ffffff','#f1f4f7','#f3f6f8','#f5f8fa','#edf3f6','#e6f2f2','#e7f1f6','#f8fafb'])assert.ok(contrast(muted,surface)>=4.5,`light muted ${muted} on ${surface} is ${contrast(muted,surface).toFixed(2)}:1`);
const dark=/:root\[data-theme=dark\]\{([^}]*)\}/.exec(theme)[1],darkValue=name=>new RegExp(`--${name}:(#[0-9a-f]{3,6})`).exec(dark)[1];
for(const surface of ['paper','surface','surface-soft','surface-raised','accent','nav'])assert.ok(contrast(darkValue('muted'),darkValue(surface))>=4.5,`dark muted on --${surface} is ${contrast(darkValue('muted'),darkValue(surface)).toFixed(2)}:1`);
console.log('PASS staff type scale, control height and muted-text contrast');
