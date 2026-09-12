// Development oracle: execute pinned vscode-textmate and vscode-oniguruma.
// Production Go code is never imported to calculate these expectations.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {inputs,manifest,writeJSON} from './inputs.mjs';

const {sources,assets,fixtures,out}=inputs('lexical');
const require=createRequire(import.meta.url);
const textmate=require(path.join(sources,'vscode-textmate/release/main.js'));
const oniguruma=require(path.join(sources,'vscode-oniguruma/release/main.js'));
const wasm=fs.readFileSync(path.join(sources,'vscode-oniguruma/release/onig.wasm'));
await oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength));

const extension=JSON.parse(fs.readFileSync(path.join(assets,'ansible-package.json'),'utf8'));
const grammars=new Map();
const injections=new Map();
for(const contribution of extension.contributes.grammars){
 const grammarPath=path.join(assets,'grammars',contribution.scopeName+'.json');
 grammars.set(contribution.scopeName,grammarPath);
 for(const target of contribution.injectTo??[]){
  const targets=injections.get(target)??[];
  targets.push(contribution.scopeName);
  injections.set(target,targets);
 }
}

const source=fs.readFileSync(path.join(fixtures,'compatibility.yaml'),'utf8');
const lines=source.endsWith('\n')?source.slice(0,-1).split('\n'):source.split('\n');
const results=[];
for(const [name,themeName] of [['dark','one-dark-pro'],['light','one-light']]){
 const theme=JSON.parse(fs.readFileSync(path.join(assets,'themes',themeName+'.json'),'utf8'));
 const registry=new textmate.Registry({
  theme:{name:theme.name,settings:[{settings:{foreground:theme.colors['editor.foreground'],background:theme.colors['editor.background']}},...theme.tokenColors]},
  onigLib:Promise.resolve({
   createOnigScanner:patterns=>new oniguruma.OnigScanner(patterns),
   createOnigString:value=>new oniguruma.OnigString(value),
  }),
  loadGrammar:async scopeName=>{
   const grammarPath=grammars.get(scopeName);
   if(!grammarPath)throw Error(`unavailable grammar ${JSON.stringify(scopeName)}`);
   return textmate.parseRawGrammar(fs.readFileSync(grammarPath,'utf8'),grammarPath);
  },
  getInjections:scopeName=>injections.get(scopeName)??[],
 });
 const grammar=await registry.loadGrammar('source.ansible');
 if(!grammar)throw Error('failed to load source.ansible grammar');
 results.push([name,{
  textmate:manifest.lexical.packages['vscode-textmate'].version,
  oniguruma:manifest.lexical.packages['vscode-oniguruma'].version,
  source:manifest.lexical.sourceLabel,
  tokens:tokenize(grammar,registry.getColorMap()),
 }]);
 registry.dispose();
}
for(const [name,result] of results)writeJSON(out,`oracle-${name}.json`,result);

function tokenize(grammar,colors){
 const result=[];
 let stack=textmate.INITIAL;
 for(const [lineIndex,line] of lines.entries()){
  const scoped=grammar.tokenizeLine(line,stack);
  const styled=grammar.tokenizeLine2(line,stack);
  stack=scoped.ruleStack;
  const boundaries=new Set([0,line.length]);
  for(const token of scoped.tokens){boundaries.add(Math.min(token.startIndex,line.length));boundaries.add(Math.min(token.endIndex,line.length));}
  for(let i=0;i<styled.tokens.length;i+=2)boundaries.add(Math.min(styled.tokens[i],line.length));
  const ordered=[...boundaries].sort((a,b)=>a-b);
  let scopeIndex=0,styleIndex=0;
  for(let i=0;i+1<ordered.length;i++){
   const start=ordered[i],end=ordered[i+1];
   if(start===end)continue;
   while(scopeIndex+1<scoped.tokens.length&&scoped.tokens[scopeIndex].endIndex<=start)scopeIndex++;
   while(styleIndex+2<styled.tokens.length&&styled.tokens[styleIndex+2]<=start)styleIndex+=2;
   const metadata=styled.tokens[styleIndex+1];
   const color=colors[(metadata&16744448)>>>15];
   if(!color)throw Error(`missing foreground for line ${lineIndex+1}, column ${start}`);
   result.push({
    line:lineIndex+1,
    start,
    end,
    text:line.slice(start,end),
    scopes:scoped.tokens[scopeIndex].scopes,
    color,
    fontStyle:(metadata&30720)>>>11,
   });
  }
 }
 return result;
}
