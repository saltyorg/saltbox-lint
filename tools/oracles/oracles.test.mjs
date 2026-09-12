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
 const sources=path.join(tool,'sources'),assets=path.join(temp,'assets'),fixtures=path.join(temp,'fixtures'),out=path.join(temp,'output');
 fs.cpSync(path.join(repo,'highlight/assets'),assets,{recursive:true});
 fs.cpSync(path.join(repo,'highlight/semantics/testdata'),fixtures,{recursive:true});
 for(const [script,extra] of [['style.mjs',['--assets',assets]],['semantic.mjs',['--fixtures',fixtures]]]){
  const result=invoke(tool,script,['--sources',sources,'--out',out,...extra],temp);
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');
 }
 for(const name of ['upstream-semantic-style-cases.json','semantic-fallback-colors.json'])assert.deepEqual(read(path.join(out,name)),read(path.join(repo,'highlight/testdata',name)),name);
 assert.deepEqual(read(path.join(out,'upstream-semantic-cases.json')),read(path.join(fixtures,'upstream-semantic-cases.json')));
 for(const name of ['demo-tasks-semantic-oracle.json','demo-defaults-semantic-oracle.json','decorated-scalar-keys-oracle.json'])assert.deepEqual(read(path.join(out,name)).tokens,read(path.join(fixtures,name)).tokens,name);
 // Corrupted independent source must be rejected before publishing any output.
 fs.appendFileSync(path.join(sources,'vscode/textMateScopeMatcher.ts'),'\n// changed\n');
 const badOut=path.join(temp,'invalid');
 const result=invoke(tool,'style.mjs',['--sources',sources,'--assets',assets,'--out',badOut],temp);
 assert.notEqual(result.status,0);assert.match(result.stderr,/SHA256.*textMateScopeMatcher.ts/);assert.equal(fs.existsSync(badOut),false);
});
