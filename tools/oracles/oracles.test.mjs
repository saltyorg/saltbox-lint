import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const root=path.dirname(fileURLToPath(import.meta.url));
const repo=path.resolve(root,'../..');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function invoke(tool,script,args,cwd){return spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',path.join(tool,script),...args],{cwd,encoding:'utf8'});}

test('independent runners reproduce frozen expectations from copied inputs in a temporary working directory',t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'saltbox-oracles-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const tool=path.join(temp,'tool');fs.cpSync(root,tool,{recursive:true});
 const sources=path.join(tool,'sources'),assets=path.join(temp,'assets'),fixtures=path.join(temp,'fixtures'),lexicalFixtures=path.join(temp,'lexical-fixtures'),out=path.join(temp,'output');
 fs.cpSync(path.join(repo,'highlight/assets'),assets,{recursive:true});
 fs.cpSync(path.join(repo,'highlight/semantics/testdata'),fixtures,{recursive:true});
 fs.cpSync(path.join(repo,'highlight/testdata'),lexicalFixtures,{recursive:true});
 for(const [script,extra] of [['style.mjs',['--assets',assets]],['semantic.mjs',['--fixtures',fixtures]]]){
  const result=invoke(tool,script,['--sources',sources,'--out',out,...extra],temp);
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
 }
 const lexical=invoke(tool,'lexical.mjs',['--sources',sources,'--assets',assets,'--fixtures',lexicalFixtures,'--out',out],temp);
 assert.equal(lexical.status,0,lexical.stderr);assert.equal(lexical.stderr,'');
 for(const name of ['upstream-semantic-style-cases.json','semantic-fallback-colors.json'])assert.deepEqual(read(path.join(out,name)),read(path.join(repo,'highlight/testdata',name)),name);
 for(const name of ['oracle-dark.json','oracle-light.json'])assert.deepEqual(read(path.join(out,name)),read(path.join(repo,'highlight/testdata',name)),name);
 assert.deepEqual(read(path.join(out,'upstream-semantic-cases.json')),read(path.join(fixtures,'upstream-semantic-cases.json')));
 for(const name of ['demo-tasks-semantic-oracle.json','demo-defaults-semantic-oracle.json','decorated-scalar-keys-oracle.json'])assert.deepEqual(read(path.join(out,name)).tokens,read(path.join(fixtures,name)).tokens,name);
 // Changed lexical inputs and executable dependencies must fail before output publication.
 fs.appendFileSync(path.join(lexicalFixtures,'compatibility.yaml'),'# changed\n');
 const badLexicalInput=path.join(temp,'invalid-lexical-input');
 const badInput=invoke(tool,'lexical.mjs',['--sources',sources,'--assets',assets,'--fixtures',lexicalFixtures,'--out',badLexicalInput],temp);
 assert.notEqual(badInput.status,0);assert.match(badInput.stderr,/SHA256.*compatibility.yaml/);assert.equal(fs.existsSync(badLexicalInput),false);
 fs.copyFileSync(path.join(repo,'highlight/testdata/compatibility.yaml'),path.join(lexicalFixtures,'compatibility.yaml'));
 fs.appendFileSync(path.join(sources,'vscode-textmate/release/main.js'),'\n// changed\n');
 const badLexicalDependency=path.join(temp,'invalid-lexical-dependency');
 const badDependency=invoke(tool,'lexical.mjs',['--sources',sources,'--assets',assets,'--fixtures',lexicalFixtures,'--out',badLexicalDependency],temp);
 assert.notEqual(badDependency.status,0);assert.match(badDependency.stderr,/SHA256.*vscode-textmate.*main.js/);assert.equal(fs.existsSync(badLexicalDependency),false);
 // Corrupted independent source must be rejected before publishing any output.
 fs.appendFileSync(path.join(sources,'vscode/textMateScopeMatcher.ts'),'\n// changed\n');
 const badOut=path.join(temp,'invalid');
 const result=invoke(tool,'style.mjs',['--sources',sources,'--assets',assets,'--out',badOut],temp);
 assert.notEqual(result.status,0);assert.match(result.stderr,/SHA256.*textMateScopeMatcher.ts/);assert.equal(fs.existsSync(badOut),false);
});
