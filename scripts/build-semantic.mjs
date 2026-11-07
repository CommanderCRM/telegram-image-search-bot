import {loadSettings} from './settings.mjs';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {BASE,INDEX,MODEL,REVISION,downloadModel,loadEmbedder,chunks,hash} from './semantic.mjs';
process.umask(0o077);
if(process.argv.includes('--download'))await downloadModel();
const encode=await loadEmbedder();
const sourcePath=loadSettings().databasePath;
const sourceHash=hash(fs.readFileSync(sourcePath));
const source=new DatabaseSync(sourcePath,{readOnly:true});
const index=new DatabaseSync(INDEX);
index.exec(`PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
 CREATE TABLE IF NOT EXISTS documents(sha256 TEXT PRIMARY KEY,text_hash TEXT);
 CREATE TABLE IF NOT EXISTS embeddings(sha256 TEXT,chunk INTEGER,vector BLOB,PRIMARY KEY(sha256,chunk));`);
const model=MODEL+'@'+REVISION;
if(index.prepare("SELECT value FROM meta WHERE key='model'").get()?.value!==model)
  index.exec('DELETE FROM documents;DELETE FROM embeddings;DELETE FROM meta;');
index.prepare("INSERT OR REPLACE INTO meta VALUES('model',?)").run(model);
const rows=source.prepare('SELECT sha256,text FROM images ORDER BY sha256').all();
let done=0,changed=0;
for(const row of rows){
  const digest=hash(row.text);
  if(index.prepare('SELECT text_hash FROM documents WHERE sha256=?').get(row.sha256)?.text_hash!==digest){
    const passages=chunks(row.text);const embeddings=[];
    for(let n=0;n<passages.length;n+=8)embeddings.push(...await encode(passages.slice(n,n+8),'passage: '));
    index.exec('BEGIN');
    try{
      index.prepare('DELETE FROM embeddings WHERE sha256=?').run(row.sha256);
      embeddings.forEach((vector,i)=>index.prepare('INSERT INTO embeddings VALUES(?,?,?)').run(row.sha256,i,Buffer.from(vector.buffer)));
      index.prepare('INSERT OR REPLACE INTO documents VALUES(?,?)').run(row.sha256,digest);
      index.exec('COMMIT');changed++;
    }catch(error){index.exec('ROLLBACK');throw error;}
  }
  if(++done%250===0)console.log(`Embedding ${done}/${rows.length}; new ${changed}`);
}
const keep=new Set(rows.map(row=>row.sha256));
if(hash(fs.readFileSync(sourcePath))!==sourceHash)throw new Error('SOURCE_CHANGED_DURING_EMBEDDING');
index.exec('BEGIN');
for(const row of index.prepare('SELECT sha256 FROM documents').all())if(!keep.has(row.sha256)){
  index.prepare('DELETE FROM documents WHERE sha256=?').run(row.sha256);
  index.prepare('DELETE FROM embeddings WHERE sha256=?').run(row.sha256);
}
for(const [key,value] of Object.entries({source_hash:sourceHash,model,version:String(Date.now())}))
  index.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,value);
index.exec('COMMIT');
console.log(JSON.stringify({documents:rows.length,embedded:changed,chunks:index.prepare('SELECT count(*) n FROM embeddings').get().n,model}));
index.close();source.close();
