// SPDX-License-Identifier: AGPL-3.0-only
'use strict';
// Shared chart markup in the small VM fixtures. Sheet geometry is covered separately.
const vm=require('node:vm'),fs=require('node:fs'),create=vm.createContext;
const source=fs.readFileSync('web/app.js','utf8');
const helpers=source.slice(source.indexOf('// Chart list layout helpers.'),source.indexOf('// End chart list layout helpers.')).split("if(typeof document!=='undefined'){")[0];
vm.createContext=(...args)=>{const context=create(...args);vm.runInContext(helpers,context);vm.runInContext('chartOpenEditor=id=>$(id);alignChartContent=()=>{};chartCloseSheets=()=>{};chartResetSectionSheets=()=>{};',context);return context;};
