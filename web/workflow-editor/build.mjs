// SPDX-License-Identifier: AGPL-3.0-only
import {build} from 'esbuild';
import {readFile,writeFile} from 'node:fs/promises';
const result=await build({entryPoints:['index.js'],bundle:true,format:'iife',platform:'browser',target:['es2022'],outfile:'../workflow-editor.js',minify:true,legalComments:'eof',metafile:true,banner:{js:'/* SunCharts Workflow Studio. AGPL-3.0-only application code; MIT/BSD third-party components. See workflow-editor.LICENSE.txt. */'}});
const names=new Set(Object.keys(result.metafile.inputs).filter(path=>path.startsWith('node_modules/')).map(path=>path.split('/')[1].startsWith('@')?path.split('/').slice(1,3).join('/'):path.split('/')[1]));
let notices='SunCharts Workflow Studio uses the following self-hosted dependencies.\nApplication source: web/workflow-editor/index.js (AGPL-3.0-only).\nNo remote scripts or code execution service is used.\n\n';
const reteLicense=await readFile('RETE-LICENSE.txt','utf8');
for(const name of [...names].sort()){
 const metadata=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8'));let license='';
 for(const file of ['LICENSE','LICENSE.md','LICENSE.txt'])try{license=await readFile(`node_modules/${name}/${file}`,'utf8');break;}catch{}
 if(!license&&['rete','rete-area-plugin','rete-connection-plugin','rete-render-utils','@retejs/lit-plugin'].includes(name))license=name==='@retejs/lit-plugin'?reteLicense.replace('Copyright (c) 2023 \"Ni55aN\" Vitaliy Stoliarov','Copyright Vitaliy Stoliarov'):reteLicense;
 if(!license)throw new Error(`Missing license text for ${name}`);
 notices+=`${name} ${metadata.version} (${metadata.license})\n${license}\n\n`;
}
await writeFile('../workflow-editor.LICENSE.txt',notices);
