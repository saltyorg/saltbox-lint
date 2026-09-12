import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
const manifest=JSON.parse(fs.readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
export function inputs(kind){
 const options={sources:{type:'string'},out:{type:'string'},[kind==='style'?'assets':'fixtures']:{type:'string'}};
 const {values}=parseArgs({options});
 for(const name of Object.keys(options))if(!values[name])throw Error(`missing --${name} directory`);
 if(process.versions.node!==manifest.node)throw Error(`require Node ${manifest.node}; got ${process.versions.node}`);
 verify(values.sources,manifest.sources);
 if(kind==='style')verify(values.assets,manifest.assets);
 else verify(values.fixtures,manifest.fixtures);
 return values;
}
function verify(root,hashes){
 for(const [name,want] of Object.entries(hashes)){
  const file=path.join(root,name);
  const got=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(got!==want)throw Error(`SHA256 mismatch: ${file}; want ${want}, got ${got}`);
 }
}
export function writeJSON(out,name,value){
 fs.mkdirSync(out,{recursive:true});
 fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2)+'\n');
}
