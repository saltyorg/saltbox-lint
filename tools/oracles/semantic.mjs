// Original upstream provider execution with independently captured fixture-specific
// DocsLibrary results. This runner neither imports Go nor computes expected tokens.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {inputs,writeJSON} from './inputs.mjs';
const {sources,out,fixtures}=inputs('semantic');
const {doSemanticTokens,tokenTypes,tokenModifiers}=await import(pathToFileURL(path.join(sources,'ansible/providers/semanticTokenProvider.js')));
const captured=JSON.parse(fs.readFileSync(path.join(sources,'module-docs.json'),'utf8'));
function optionsMap(options){return new Map(Object.entries(options).map(([key,option])=>[key,{type:option.type,suboptions:optionsMap(option.suboptions)}]));}
const library={async findModule(name){
 const module=captured.modules[name];
 if(!module)throw Error(`module ${JSON.stringify(name)} is outside the captured fixture input`);
 return [module.found?{documentation:module.documented?{options:optionsMap(module.options)}:undefined}:undefined,module.fqcn];
}};
async function tokens(source,uri='file:///srv/git/saltbox/roles/web/tasks/main.yml'){
 const document={uri,getText(){return source;},positionAt(offset){const prefix=source.slice(0,offset).split('\n');return {line:prefix.length-1,character:prefix.at(-1).length};}};
 const result=await doSemanticTokens(document,library);
 const lines=source.split('\n'),tokens=[];let line=0,column=0;
 for(let i=0;i<result.data.length;i+=5){
  const [dl,dc,length,type,mods]=result.data.slice(i,i+5);line+=dl;column=dl===0?column+dc:dc;
  tokens.push({line:line+1,column:column+1,length,text:lines[line].slice(column,column+length),type:tokenTypes[type],modifiers:tokenModifiers.filter((_,n)=>mods&(1<<n))});
 }
 return tokens;
}
const cases=JSON.parse(fs.readFileSync(path.join(sources,'oracle-cases.json'),'utf8'));
for(const item of cases){
 try {item.tokens=await tokens(item.source,item.uri);}
 catch(error){item.error=String(error);}
}
writeJSON(out,'upstream-semantic-cases.json',cases);
for(const [source,name] of [['demo-tasks','demo-tasks-semantic-oracle'],['demo-defaults','demo-defaults-semantic-oracle'],['decorated-scalar-keys','decorated-scalar-keys-oracle']]){
 writeJSON(out,name+'.json',{
  method:'unmodified pinned Ansible 26.8.2 semantic provider with captured fixture-specific DocsLibrary schemas',
  documentationInput:'module-docs.json (23 module names; original discovery paths are provenance only)',
  tokens:await tokens(fs.readFileSync(path.join(fixtures,source+'.yml'),'utf8')),
 });
}
