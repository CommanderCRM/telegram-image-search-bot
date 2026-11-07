import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function loadSettings(){
  let data;
  try{data=JSON.parse(fs.readFileSync(path.join(base,'.local/config.json'),'utf8'));}
  catch{throw new Error('Create .local/config.json from config.example.json');}
  if(typeof data.botUsername!=='string'||!/^\w{3,100}$/.test(data.botUsername)
    ||typeof data.imageRoot!=='string'||!path.isAbsolute(data.imageRoot)
    ||typeof data.databasePath!=='string'||!path.isAbsolute(data.databasePath))throw new Error('Invalid local configuration');
  return {botUsername:data.botUsername,imageRoot:data.imageRoot,databasePath:data.databasePath};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]!=='username')throw new Error('Unsupported operation');
  console.log(loadSettings().botUsername);
}
